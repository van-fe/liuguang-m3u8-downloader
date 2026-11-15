import { mkdir, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('playwright');
const runId = `live-${Date.now()}`;
const output = path.join(root, 'test-results', 'sites', runId);
await mkdir(output, { recursive: true });
const selected = process.argv.slice(2);
const cases = selected.length ? selected.map(url => ({ name: new URL(url).hostname, url })) : [
  { name: 'Mux DK Turntable', url: 'https://test-streams.mux.dev/pts_shift/master.m3u8' },
  { name: 'Shaka Angel One (fMP4 + separate audio)', url: 'https://storage.googleapis.com/shaka-demo-assets/angel-one-hls/hls.m3u8' }
];
const reports = [];
const context = await chromium.launchPersistentContext(path.join(root, `.site-test-profile-${runId}`), {
  executablePath: process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ignoreDefaultArgs: ['--disable-extensions'], headless: true, args: ['--enable-unsafe-extension-debugging'],
  acceptDownloads: true, downloadsPath: path.join(output, 'downloads'), viewport: { width: 1280, height: 800 }
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let stopRequested = false;
process.on('SIGINT', () => { stopRequested = true; });
function probeFile(filename) {
  const result = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr.slice(-1500));
  return JSON.parse(result.stdout);
}
try {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist', 'liuguang-m3u8') });
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js')) || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  await send('SAVE_SETTINGS', { settings: { saveAs: false, concurrency: 4, retries: 2 } });
  for (const [index, item] of cases.entries()) {
    if (stopRequested) break;
    const report = { ...item, testedAt: new Date().toISOString() };
    reports.push(report);
    const page = await context.newPage();
    let preview;
    console.log(`TEST ${item.name}: ${item.url}`);
    try {
      report.pageUrl = `https://hlsjs.video-dev.org/demo/?src=${encodeURIComponent(item.url)}`;
      await page.goto(report.pageUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });
      const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = await send('GET_STATE', { tabId });
        report.detected = state.streams?.some(stream => stream.url === item.url) || false;
        if (report.detected) break;
        await pause(300);
      }
      report.pagePlayback = await page.locator('video').evaluate(video => {
        video.muted = true; video.play().catch(() => {});
        return { readyState: video.readyState, duration: video.duration, currentTime: video.currentTime };
      });
      await page.screenshot({ path: path.join(output, `${index + 1}-website.png`), timeout: 15000 }).catch(() => {});
      await page.locator('video').evaluate(video => video.pause());
      if (!report.detected) throw new Error('The live website did not expose the selected HLS URL to automatic detection.');
      console.log('PASS automatic detection');
      const newPage = context.waitForEvent('page');
      const opened = await send('OPEN_PREVIEW', { url: item.url, title: item.name, tabId });
      if (!opened.ok) throw new Error(opened.error);
      preview = await newPage;
      await preview.waitForLoadState();
      try {
        await preview.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 60000 });
        await preview.locator('video').evaluate(async video => { video.muted = true; await video.play(); });
        await preview.waitForFunction(() => document.querySelector('video').currentTime > 0.1);
        report.preview = true;
        report.previewDuration = await preview.locator('video').evaluate(video => video.duration);
        await preview.screenshot({ path: path.join(output, `${index + 1}-preview.png`) });
        await preview.locator('video').evaluate(video => video.pause());
        console.log('PASS preview playback');
      } catch (error) {
        report.preview = false;
        report.previewError = await preview.locator('#error').textContent().catch(() => error.message);
        console.log(`PREVIEW FAIL ${report.previewError}`);
      }
      const start = await send('START_DOWNLOAD', { tabId, url: item.url, title: `site-${index + 1}-${item.name}`, saveAs: false });
      if (!start.ok) throw new Error(start.error);
      report.jobId = start.jobId;
      const started = Date.now();
      let logAt = 0, status;
      while (Date.now() - started < 15 * 60 * 1000) {
        if (stopRequested) { await send('CANCEL_JOB', { jobId: start.jobId }); throw new Error('测试由操作者停止'); }
        const state = await send('GET_STATE', { tabId });
        const job = state.jobs.find(job => job.id === start.jobId);
        if (job.status !== status || Date.now() - logAt > 15000) {
          status = job.status; logAt = Date.now();
          console.log(JSON.stringify({ name: item.name, status, progress: job.progress, bytes: job.bytes, segments: `${job.completedSegments}/${job.totalSegments}`, elapsed: Math.round((Date.now() - started) / 1000) }));
        }
        if (['error', 'cancelled'].includes(job.status)) throw new Error(job.error || job.status);
        if (job.status === 'complete') { report.job = job; break; }
        await pause(300);
      }
      if (!report.job) { await send('CANCEL_JOB', { jobId: start.jobId }); throw new Error('Live download timeout'); }
      const download = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], report.job.downloadId);
      report.fileBytes = (await stat(download.filename)).size;
      const probe = probeFile(download.filename);
      report.duration = Number(probe.format.duration);
      report.streams = probe.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, width: stream.width, height: stream.height }));
      if (!report.streams.some(stream => stream.type === 'video') || !report.streams.some(stream => stream.type === 'audio')) throw new Error('Saved MP4 is missing video or audio');
      const decode = spawnSync('ffmpeg', ['-v', 'error', '-sseof', '-1', '-i', download.filename, '-t', '0.5', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
      if (decode.status !== 0) throw new Error(decode.stderr.slice(-1800));
      report.download = true;
      report.tailDecode = true;
      console.log(`PASS downloaded MP4: ${report.fileBytes} bytes, ${report.duration}s, ${JSON.stringify(report.streams)}`);
    } catch (error) {
      report.error = error.message;
      console.log(`FAIL ${item.name}: ${error.message}`);
    } finally {
      await writeFile(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
      await preview?.close();
      await page.close();
    }
  }
  console.log(`REPORT ${output}`);
} finally { await context.close(); }
