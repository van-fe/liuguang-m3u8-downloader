import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareNativeDownloads, useNativeDownloads, createPassiveFilenameExtension, loadExtension, assertForeignFilename, observeExtensionConsole } from './e2e-downloads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('playwright');
const results = path.join(root, 'test-results', 'filename-e2e');
const fixtures = path.join(results, 'fixtures');
await mkdir(fixtures, { recursive: true });
const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'hls', '-hls_time', '1',
  '-hls_playlist_type', 'vod', path.join(fixtures, 'video.m3u8')], { encoding: 'utf8', windowsHide: true });
assert.equal(generated.status, 0, generated.stderr);
await writeFile(path.join(fixtures, 'invalid.mp4'), '<html>Access denied</html>');
const helperPath = await createPassiveFilenameExtension(path.join(results, 'passive-extension'));
const extensionPath = path.join(root, 'dist', 'liuguang-m3u8');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const summary = [];
const server = createServer(async (request, response) => {
  try {
    const filename = path.basename(new URL(request.url, 'http://localhost').pathname);
    const bytes = await readFile(path.join(fixtures, filename));
    response.setHeader('Content-Type', filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    response.end(bytes);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const mode of ['alone', 'legacy-passive-before', 'legacy-passive-after']) {
    const label = mode;
    const passive = mode !== 'alone';
    const output = path.join(results, `${Date.now()}-${label}`);
    const profile = path.join(root, `.filename-e2e-${Date.now()}-${label}`);
    await prepareNativeDownloads(profile, output);
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        ignoreDefaultArgs: ['--disable-extensions'], headless: true, args: ['--enable-unsafe-extension-debugging'],
        acceptDownloads: true, downloadsPath: output, viewport: { width: 440, height: 720 }
      });
      const cdp = await context.browser().newBrowserCDPSession();
      await useNativeDownloads(cdp);
      let helper;
      if (mode === 'legacy-passive-before') helper = await loadExtension(context, cdp, helperPath);
      const { id, worker } = await loadExtension(context, cdp, extensionPath);
      if (passive && !helper) helper = await loadExtension(context, cdp, helperPath);
      const consoleErrors = [];
      const capture = entry => {
        if (['error', 'warning', 'exception'].includes(entry.type)) consoleErrors.push({
          type: entry.type,
          invalidFilename: /invalid filename/i.test(entry.message),
          unexpectedDeterminer: /unexpected.*determin/i.test(entry.message),
          tooManyListeners: /too many listeners/i.test(entry.message),
          runtimeLastError: /runtime\.lastError/i.test(entry.message),
          message: entry.message.replace(/(?:https?|blob):\S+/gi, '[address]')
        });
      };
      const stopConsole = await observeExtensionConsole(cdp, id, capture);
      const stopHelperConsole = helper && await observeExtensionConsole(cdp, helper.id, capture);
      if (helper) assert.equal(await helper.worker.evaluate(() => chrome.downloads.onDeterminingFilename.hasListeners()), true);
      await worker.evaluate(() => {
        globalThis.filenameProbe = [];
        chrome.downloads.onCreated.addListener(item => {
          chrome.storage.session.get('liuguangDownloadNamesV1').then(saved => {
            globalThis.filenameProbe.push({
              id: item.id, byExtensionId: item.byExtensionId,
              registryEntries: saved.liuguangDownloadNamesV1?.map(entry => ({
                matchesUrl: entry.url === item.url, hasMp4Suffix: /\.mp4$/i.test(entry.filename),
                hasDownloadId: Number.isInteger(entry.downloadId)
              })) || []
            });
          });
        });
      });
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${id}/popup.html`);
      const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
      await popup.locator('#auto-save').check();
      for (let attempt = 0; attempt < 100; attempt++) {
        if ((await send('GET_STATE')).settings.saveAs === false) break;
        assert.notEqual(attempt, 99, 'Automatic-save setting must persist.');
        await pause(50);
      }
      await popup.evaluate(() => {
        const download = chrome.downloads.download.bind(chrome.downloads);
        chrome.downloads.download = options => download({ ...options, saveAs: false });
      });
      async function waitJob(jobId, expected = 'complete') {
        for (let attempt = 0; attempt < 400; attempt++) {
          const job = (await send('GET_STATE')).jobs.find(item => item.id === jobId);
          if (job?.status === expected) return job;
          assert.ok(!['error', 'cancelled'].includes(job?.status), `Local filename fixture job failed: ${job?.error || job?.status}`);
          await pause(50);
        }
        throw new Error('Local filename fixture job timed out.');
      }
      async function assertName(job, expected) {
        assert.ok(Number.isInteger(job.downloadId) && job.downloadId >= 0, 'The completed job must own a concrete Chrome download ID.');
        const item = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], job.downloadId);
        assert.equal(item.state, 'complete');
        if (path.basename(item.filename) !== expected) {
          console.error('Filename arbitration diagnostics', JSON.stringify({
            extensionId: id,
            ownListener: await worker.evaluate(() => chrome.downloads.onDeterminingFilename.hasListeners()),
            passiveEvent: helper && await helper.worker.evaluate(() => globalThis.lastFilenameEvent),
            createdEvents: await worker.evaluate(() => globalThis.filenameProbe),
            consoleErrors
          }));
        }
        assert.equal(path.basename(item.filename), expected);
        assert.equal(path.dirname(item.filename).toLowerCase(), output.toLowerCase());
        assert.ok((await stat(item.filename)).size > 1000);
        summary.push({ mode: label, kind: 'mp4', basename: expected });
      }
      const started = await send('START_DOWNLOAD', { url: `${base}/video.m3u8`, title: '中文视频标题', saveAs: false });
      assert.equal(started.ok, true, started.error);
      await assertName(await waitJob(started.jobId), '中文视频标题.mp4');
      const repeated = await send('START_DOWNLOAD', { url: `${base}/video.m3u8?duplicate=1`, title: '中文视频标题', saveAs: false });
      assert.equal(repeated.ok, true, repeated.error);
      await assertName(await waitJob(repeated.jobId), '中文视频标题 (1).mp4');
      await popup.locator('#manual-details').evaluate(element => { element.open = true; });
      await popup.locator('#manual-url').fill(`${base}/video.m3u8?manual=1`);
      await popup.locator('#manual-title').fill('手填名称 2026.mp4');
      await popup.locator('#manual-submit').click();
      let manual;
      for (let attempt = 0; attempt < 100; attempt++) {
        manual = (await send('GET_STATE')).jobs.find(item => item.title === '手填名称 2026.mp4');
        if (manual) break;
        await pause(50);
      }
      assert.ok(manual);
      await assertName(await waitJob(manual.id), '手填名称 2026.mp4');
      const invalid = await send('START_DOWNLOAD', { url: `${base}/invalid.mp4?token=local-secret`, title: 'private-title-not-in-diagnostic', saveAs: false });
      assert.equal(invalid.ok, true, invalid.error);
      await waitJob(invalid.jobId, 'error');
      await popup.locator('#jobs-tab').click();
      for (const [kind, button] of [
        ['individual', popup.locator(`button[data-diagnostic-job-id="${invalid.jobId}"]`)],
        ['all', popup.locator('#export-diagnostics')]
      ]) {
        const knownIds = await worker.evaluate(async () => (await chrome.downloads.search({ limit: 100 })).map(item => item.id));
        await button.click();
        let item;
        for (let attempt = 0; attempt < 100; attempt++) {
          item = await worker.evaluate(async previous => (await chrome.downloads.search({ limit: 100 }))
            .find(entry => !previous.includes(entry.id) && entry.state === 'complete' && /^application\/json(?:;|$)/i.test(entry.mime)), knownIds);
          if (item) break;
          await pause(50);
        }
        assert.ok(item, 'Diagnostic UI must produce a completed JSON file.');
        // JSON export retains the Chrome API/save-dialog path. Its suggested
        // name can still be affected by Chrome 156's legacy passive listener bug.
        // Verify export contents, recording that filename limitation explicitly.
        const contents = await readFile(item.filename, 'utf8');
        const parsed = JSON.parse(contents);
        assert.ok(parsed.reports.some(report => report.jobId === invalid.jobId));
        assert.doesNotMatch(contents, /127\.0\.0\.1|localhost|local-secret|private-title-not-in-diagnostic/);
        summary.push({ mode: label, kind, basename: path.basename(item.filename),
          suggestedNamePreserved: /^liuguang-diagnostics-\d{8}-\d{6}(?: \(\d+\))?\.json$/.test(path.basename(item.filename)) });
      }
      await assertForeignFilename(context, cdp, helperPath, helper);
      summary.push({ mode: label, kind: 'foreign-extension', basename: '其他扩展自己的文件.txt' });
      assert.equal(await worker.evaluate(() => chrome.downloads.onDeterminingFilename.hasListeners()), false, 'This extension must not register a global filename listener.');
      if (helper) assert.ok(await helper.worker.evaluate(() => globalThis.filenameEvents) >= 6);
      console.log(`PASS native default / ${label}: 中文标题、重名加序号、手填名、单项/全局日志、其他扩展下载名称`);
      await stopConsole();
      await stopHelperConsole?.();
      await cdp.detach();
    } finally { await context?.close(); }
  }
  await writeFile(path.join(results, 'result.json'), JSON.stringify({
    testedAt: new Date().toISOString(), downloadPolicy: 'default',
    verifiedScope: 'Automatic MP4 saves, including a custom title entered in the UI.',
    limitations: [
      'Native Save As dialogs are not exercised by headless tests; JSON exports bypass only the dialog in the test.',
      'Manual saveAs:true MP4 and JSON exports retain Chrome API behavior; legacy passive filename listeners can still affect their suggested names.'
    ], tests: summary
  }, null, 2));
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
