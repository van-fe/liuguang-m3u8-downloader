import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('playwright');
const postUrl = process.env.X_TEST_POST_URL || 'https://x.com/SpaceX/status/1845922924315938922';
const results = path.join(root, 'test-results', 'x');
await mkdir(results, { recursive: true });
const summary = { postUrl, testedAt: new Date().toISOString(), tests: [] };
const runId = Date.now();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function launch(name) {
  const context = await chromium.launchPersistentContext(path.join(root, `.x-test-profile-${runId}-${name}`), {
    executablePath: process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ignoreDefaultArgs: ['--disable-extensions'], headless: true,
    args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true,
    downloadsPath: path.join(results, 'downloads'), viewport: { width: 1280, height: 800 }
  });
  const cdp = await context.browser().newBrowserCDPSession();
  const loaded = await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist', 'liuguang-m3u8') });
  const matches = worker => worker.url() === `chrome-extension://${loaded.id}/background.js`;
  const worker = context.serviceWorkers().find(matches) || await context.waitForEvent('serviceworker', { predicate: matches });
  const id = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  await send('SAVE_SETTINGS', { settings: { saveAs: false, concurrency: 4, retries: 2 } });
  async function waitJob(jobId) {
    let previous;
    for (let attempt = 0; attempt < 1200; attempt++) {
      const state = await send('GET_STATE');
      const job = state.jobs.find(item => item.id === jobId);
      if (job?.status !== previous) { previous = job?.status; console.log(JSON.stringify({ jobId, status: job?.status, bytes: job?.bytes })); }
      if (job?.status === 'complete') return job;
      if (['error', 'cancelled'].includes(job?.status)) throw new Error(JSON.stringify(job));
      await pause(200);
    }
    await send('CANCEL_JOB', { jobId });
    throw new Error('X 下载超时');
  }
  async function checkMP4(job, name) {
    const download = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], job.downloadId);
    assert.equal(download.state, 'complete');
    const destination = path.join(results, `${name}.mp4`);
    await copyFile(download.filename, destination);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', destination], { encoding: 'utf8', windowsHide: true });
    assert.equal(probe.status, 0, probe.stderr);
    const data = JSON.parse(probe.stdout);
    assert.ok(data.streams.some(stream => stream.codec_type === 'video'));
    assert.ok(data.streams.some(stream => stream.codec_type === 'audio'));
    assert.ok(Number(data.format.duration) > 1);
    const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', destination, '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
    assert.equal(decode.status, 0, decode.stderr);
    const report = { name, file: destination, bytes: Number(data.format.size), duration: Number(data.format.duration), streams: data.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, width: stream.width, height: stream.height })) };
    summary.tests.push(report);
    console.log(`PASS ${name}: ${JSON.stringify(report)}`);
  }
  return { context, worker, popup, id, send, waitJob, checkMP4 };
}

let session;
try {
  session = await launch('automatic');
  let page = await session.context.newPage();
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(error => { summary.navigationNote = error.message; });
  let tabId = await session.worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  assert.ok(Number.isInteger(tabId));
  let streams;
  for (let attempt = 0; attempt < 40; attempt++) {
    streams = (await session.send('GET_STATE', { tabId })).streams;
    if (streams.some(item => item.platform === 'x' && item.format === 'mp4')) break;
    await pause(300);
  }
  let media = streams.find(item => item.platform === 'x' && item.format === 'mp4');
  if (!media) {
    summary.page = await page.evaluate(() => ({ url: location.href, title: document.title, text: document.body?.innerText.slice(0, 1800), detector: Boolean(globalThis.__liuguangDetector) })).catch(error => ({ error: error.message }));
    console.log(`NOTE real X page unavailable: ${summary.page.text?.slice(0, 100)}`);
    // Test the packaged MAIN-world observer separately with a controlled X API
    // response; media URLs and the subsequent downloads remain real public URLs.
    const payload = await session.popup.evaluate(async () => {
      const response = await fetch('https://cdn.syndication.twimg.com/tweet-result?id=1845922924315938922&lang=en&token=4h34yprw8d3', { credentials: 'omit', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`Public X metadata: HTTP ${response.status}`);
      return response.json();
    });
    await session.context.route('https://x.com/i/api/graphql/liuguang-test/HomeTimeline', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) }));
    await session.context.route('https://x.com/home', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>X observer integration test</title><h1>Controlled X response integration test</h1><script>fetch("/i/api/graphql/liuguang-test/HomeTimeline").then(r=>r.json()).then(()=>document.body.dataset.loaded="true")</script>' }));
    const original = page;
    page = await session.context.newPage();
    await page.goto('https://x.com/home');
    await original.close();
    tabId = await session.worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url === 'https://x.com/home').id);
    for (let attempt = 0; attempt < 60; attempt++) {
      streams = (await session.send('GET_STATE', { tabId })).streams;
      media = streams.find(item => item.platform === 'x' && item.format === 'mp4');
      if (media) break;
      await pause(200);
    }
    summary.observerTest = 'controlled-X-page-response';
  } else {
    summary.observerTest = 'real-X-page-or-public-metadata';
  }
  assert.ok(media, `未能自动检测 X 视频：${JSON.stringify(streams)}`);
  assert.ok(media.variants.some(variant => variant.type === 'hls'));
  assert.ok(media.variants.filter(variant => variant.type === 'mp4').length >= 1);
  summary.detected = { title: media.title, platform: media.platform, format: media.format, postId: media.postId, variantCount: media.variants.length };
  await page.bringToFront();
  await session.popup.reload();
  await session.popup.getByRole('button', { name: /发现视频/ }).click();
  await session.popup.waitForFunction(() => document.querySelectorAll('.stream-card').length >= 1);
  await session.popup.screenshot({ path: path.join(results, 'popup.png'), fullPage: true });
  await page.screenshot({ path: path.join(results, 'post.png'), timeout: 15000 }).catch(() => {});
  const newPage = session.context.waitForEvent('page');
  await session.send('OPEN_PREVIEW', { url: media.url, title: media.title, tabId });
  const preview = await newPage;
  await preview.waitForLoadState();
  await preview.waitForFunction(() => document.querySelector('video').readyState >= 2, null, { timeout: 45000 });
  await preview.locator('video').evaluate(async video => { video.muted = true; await video.play(); });
  await preview.waitForFunction(() => document.querySelector('video').currentTime > 0.2);
  await preview.locator('video').evaluate(video => { video.pause(); video.currentTime = Math.min(3, video.duration / 2); });
  await preview.waitForFunction(() => document.querySelector('video').readyState >= 2);
  await preview.screenshot({ path: path.join(results, 'preview.png') });
  await preview.close();
  console.log(`PASS ${summary.observerTest === 'controlled-X-page-response' ? '受控 X 页面响应' : 'X 页面'}检测、清晰度分组及真实 CDN MP4 预览`);
  const started = await session.send('START_DOWNLOAD', { url: media.url, title: media.title, tabId, saveAs: false });
  assert.equal(started.ok, true, started.error);
  await session.checkMP4(await session.waitJob(started.jobId), 'x-direct');
  const hls = media.variants.find(variant => variant.type === 'hls');
  const fallback = await session.send('START_DOWNLOAD', { url: hls.url, title: 'X HLS fallback', tabId, saveAs: false });
  assert.equal(fallback.ok, true, fallback.error);
  await session.checkMP4(await session.waitJob(fallback.jobId), 'x-hls');
  await session.context.close();
  session = await launch('manual');
  // A fresh browser session has no tab/media cache from the automatic test.
  await session.popup.locator('#manual-details').evaluate(details => { details.open = true; });
  await session.popup.locator('#manual-url').fill(postUrl);
  await session.popup.locator('#auto-save').check();
  await session.popup.locator('#manual-submit').click();
  let manual;
  for (let attempt = 0; attempt < 100; attempt++) {
    manual = (await session.send('GET_STATE')).jobs[0];
    if (manual) break;
    await pause(300);
  }
  assert.ok(manual, await session.popup.locator('#notice').textContent());
  assert.equal(manual.platform, 'x');
  assert.equal(manual.format, 'mp4');
  assert.equal(manual.saveAs, false);
  await session.checkMP4(await session.waitJob(manual.id), 'x-post-link');
  summary.ok = true;
  console.log('PASS 新会话粘贴 X 帖子链接并自动保存 MP4');
} catch (error) {
  summary.ok = false; summary.error = error.stack || error.message; throw error;
} finally {
  await writeFile(path.join(results, 'result.json'), JSON.stringify(summary, null, 2));
  await session?.context.close();
}
