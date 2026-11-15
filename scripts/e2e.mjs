import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCipheriv } from 'node:crypto';
import assert from 'node:assert/strict';
import { prepareNativeDownloads, useNativeDownloads, createPassiveFilenameExtension, loadExtension, assertForeignFilename, evaluateExtensionDocument } from './e2e-downloads.mjs';
import { testStreamTitles } from './e2e-stream-titles.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (await stat(path.join(root, '.cache', 'ms-playwright')).catch(() => null)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
}
const { chromium } = await import('playwright');
const results = path.join(root, 'test-results');
const fixtures = path.join(results, 'fixtures');
await mkdir(fixtures, { recursive: true });
function native(args, program = 'ffmpeg') {
  const result = spawnSync(program, args, { encoding: 'utf8', cwd: fixtures, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${program}: ${result.error?.message || result.stderr}`);
  return result.stdout;
}
const common = ['-hide_banner', '-loglevel', 'error', '-y'];
const video = ['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24'];
const audio = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const vcodec = ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '24'];
const hls = ['-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod'];
native([...common, ...video, ...audio, '-t', '3', ...vcodec, '-c:a', 'aac', ...hls, path.join(fixtures, 'plain.m3u8')]);
// Valid HLS with a real PCM audio track cannot be copied into an MP4 container.
// This gives the diagnostics an actual FFmpeg failure instead of a mocked log.
native([...common, ...video, ...audio, '-t', '2', ...vcodec, '-c:a', 'pcm_bluray',
  '-mpegts_m2ts_mode', '1', '-f', 'mpegts', path.join(fixtures, 'diagnostic-pcm.ts')]);
await writeFile(path.join(fixtures, 'diagnostic-pcm.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ndiagnostic-pcm.ts\n#EXT-X-ENDLIST\n');
// A CDN can return HTTP 200 while its supposed media body is an access-error page.
await writeFile(path.join(fixtures, 'diagnostic-html.ts'), '<html><body>Access denied by the media CDN</body></html>');
await writeFile(path.join(fixtures, 'diagnostic-html.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\ndiagnostic-html.ts\n#EXT-X-ENDLIST\n');
native([...common, '-i', path.join(fixtures, 'plain.m3u8'), '-c', 'copy', '-movflags', '+faststart', path.join(fixtures, 'plain.mp4')]);
await writeFile(path.join(fixtures, 'invalid.mp4'), '<html><body>This is an error document, not a valid MP4 video.</body></html>');
native([...common, ...video, '-t', '3', ...vcodec, ...hls, '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4', path.join(fixtures, 'video.m3u8')]);
native([...common, ...audio, '-t', '3', '-c:a', 'aac', ...hls, path.join(fixtures, 'audio.m3u8')]);
native([...common, ...video, ...audio, '-t', '3', ...vcodec, '-c:a', 'aac', ...hls, '-hls_flags', 'single_file', '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'range-init.mp4', path.join(fixtures, 'range.m3u8')]);
await writeFile(path.join(fixtures, 'master.m3u8'), '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="中文",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=320x180,AUDIO="sound"\nvideo.m3u8\n');
const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
await writeFile(path.join(fixtures, 'key.bin'), key);
const plain = await readFile(path.join(fixtures, 'plain.m3u8'), 'utf8');
// A valid 1x1 RGBA PNG is exactly 70 bytes. Real sites prepend this image to TS
// packets while serving every response as image/png; never treat MIME alone as video validation.
const pngPrefix = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
assert.equal(pngPrefix.length, 70);
await writeFile(path.join(fixtures, 'only-image.png'), pngPrefix);
native([...common, '-i', path.join(fixtures, 'only-image.png'), '-f', 'null', '-']);
await writeFile(path.join(fixtures, 'only-image.m3u8'), '#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:3,\nonly-image.png\n#EXT-X-ENDLIST\n');
let sequence = 7;
const encrypted = [];
const pngWrapped = [];
const encryptedPngWrapped = [];
let plainTSBytes = 0;
for (const line of plain.trim().split('\n')) {
  if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
    encrypted.push('#EXT-X-MEDIA-SEQUENCE:7', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    pngWrapped.push(line);
    encryptedPngWrapped.push('#EXT-X-MEDIA-SEQUENCE:7', '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
  } else if (line && !line.startsWith('#')) {
    const iv = Buffer.alloc(16); iv.writeBigUInt64BE(BigInt(sequence++), 8);
    const cipher = createCipheriv('aes-128-cbc', key, iv);
    const filename = `encrypted-${line}`;
    const segment = await readFile(path.join(fixtures, line));
    assert.equal(segment.length % 188, 0);
    plainTSBytes += segment.length;
    await writeFile(path.join(fixtures, filename), Buffer.concat([cipher.update(segment), cipher.final()]));
    encrypted.push(filename);
    const imageName = `png-prefixed-${line.replace(/\.ts$/, '.png')}`;
    const imagePayload = Buffer.concat([pngPrefix, segment]);
    assert.equal(imagePayload.length % 188, 70);
    await writeFile(path.join(fixtures, imageName), imagePayload);
    pngWrapped.push(imageName);
    const encryptedImageName = `encrypted-${imageName}`;
    const imageCipher = createCipheriv('aes-128-cbc', key, iv);
    await writeFile(path.join(fixtures, encryptedImageName), Buffer.concat([imageCipher.update(imagePayload), imageCipher.final()]));
    encryptedPngWrapped.push(encryptedImageName);
  } else {
    encrypted.push(line);
    pngWrapped.push(line);
    encryptedPngWrapped.push(line);
  }
}
await writeFile(path.join(fixtures, 'encrypted.m3u8'), encrypted.join('\n'));
await writeFile(path.join(fixtures, 'png-prefixed.m3u8'), pngWrapped.join('\n'));
await writeFile(path.join(fixtures, 'encrypted-png-prefixed.m3u8'), encryptedPngWrapped.join('\n'));
await writeFile(path.join(fixtures, 'live.m3u8'), plain.replace('#EXT-X-ENDLIST', ''));
await writeFile(path.join(fixtures, 'drm.m3u8'), plain.replace('#EXTM3U', '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key.bin"'));

let gateStart;
const gate = new Promise(resolve => { gateStart = resolve; });
let holdSlow = true;
let retryRequests = 0;
const heldSegments = new Map();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><html><head><title>流光自动检测测试</title></head><body><h1>自动检测测试视频</h1><video controls></video><script>fetch("/plain.m3u8");fetch("/mime-playlist");</script></body></html>');
      return;
    }
    let filename = url.pathname.slice(1);
    if (/^hold-(?:delete|clear|queued|rename)\.m3u8$/.test(filename)) {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.end(plain.replace('plain0.ts', filename.replace('.m3u8', '.ts')));
      return;
    }
    if (/^hold-(?:delete|clear|queued|rename)\.ts$/.test(filename)) {
      const bytes = await readFile(path.join(fixtures, 'plain0.ts'));
      const state = { started: true, aborted: false };
      heldSegments.set(filename, state);
      response.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': bytes.length });
      let offset = 188 * 5;
      response.write(bytes.subarray(0, offset));
      // Keep a real resource stream in flight until its AbortController closes
      // the connection. This distinguishes deleting an active job from merely
      // hiding its card while the download continues in the background.
      await new Promise(resolve => {
        state.pulse = () => {
          const end = Math.min(bytes.length - 188, offset + 32 * 1024);
          response.write(bytes.subarray(offset, end)); offset = end;
        };
        state.release = () => { response.end(bytes.subarray(offset)); resolve(); };
        response.once('close', () => {
          state.aborted = !response.writableEnded;
          resolve();
        });
      });
      return;
    }
    if (filename === 'mime-playlist' || filename === 'slow.m3u8') filename = 'plain.m3u8';
    if (filename === 'retry.m3u8') {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.end(plain.replace('plain1.ts', 'retry.ts'));
      return;
    }
    if (filename === 'retry.ts') {
      if (retryRequests++ === 0) { response.writeHead(503).end('Temporary failure'); return; }
      filename = 'plain1.ts';
    }
    if (url.pathname === '/slow.m3u8' && holdSlow) { gateStart(); await new Promise(resolve => setTimeout(resolve, 3500)); }
    const resolved = path.resolve(fixtures, filename);
    if (!resolved.startsWith(fixtures + path.sep)) { response.writeHead(403).end(); return; }
    const bytes = await readFile(resolved);
    response.setHeader('Content-Type', filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : filename.endsWith('.png') ? 'image/png' : filename.endsWith('.ts') ? 'video/mp2t' : 'application/octet-stream');
    const range = /bytes=(\d+)-(\d+)/.exec(request.headers.range || '');
    if (range) {
      const start = Number(range[1]), end = Number(range[2]);
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
      response.end(bytes.subarray(start, end + 1));
    } else { response.setHeader('Content-Length', bytes.length); response.end(bytes); }
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  const extension = path.join(root, 'dist', 'liuguang-m3u8');
  const passive = process.env.E2E_FILENAME_MODE !== 'alone';
  const passiveExtension = await createPassiveFilenameExtension(path.join(results, 'passive-filename-extension'));
  const runId = Date.now();
  const downloadPath = path.join(results, 'downloads', String(runId));
  const profilePath = path.join(root, `.test-profile-chrome-${runId}`);
  await prepareNativeDownloads(profilePath, downloadPath);
  const systemChrome = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '';
  const chromePath = process.env.E2E_CHROME_PATH || (systemChrome && await stat(systemChrome).catch(() => null) ? systemChrome : undefined);
  context = await chromium.launchPersistentContext(profilePath, {
    ...(chromePath ? { executablePath: chromePath, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }), headless: true,
    args: chromePath ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${[extension, ...(passive ? [passiveExtension] : [])].join(',')}`, `--load-extension=${[extension, ...(passive ? [passiveExtension] : [])].join(',')}`],
    acceptDownloads: true, downloadsPath: downloadPath, viewport: { width: 440, height: 720 }
  });
  const runtimeErrors = [];
  context.on('console', message => {
    if (['error', 'warning'].includes(message.type())) runtimeErrors.push(message.text());
    if (runtimeErrors.length > 50) runtimeErrors.shift();
  });
  context.on('weberror', event => {
    runtimeErrors.push(event.error().message);
    if (runtimeErrors.length > 50) runtimeErrors.shift();
  });
  let loadedId;
  const cdp = await context.browser().newBrowserCDPSession();
  await useNativeDownloads(cdp);
  let passiveLoaded;
  if (chromePath) {
    loadedId = (await cdp.send('Extensions.loadUnpacked', { path: extension })).id;
    if (passive) passiveLoaded = await loadExtension(context, cdp, passiveExtension);
  }
  const isExtensionWorker = worker => worker.url().endsWith('/background.js') && (loadedId ? worker.url().startsWith(`chrome-extension://${loadedId}/`) : worker.url().startsWith('chrome-extension://'));
  const worker = context.serviceWorkers().find(isExtensionWorker) || await context.waitForEvent('serviceworker', { predicate: isExtensionWorker });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await worker.evaluate(() => Boolean(globalThis.chrome?.tabs?.query)).catch(() => false)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const id = new URL(worker.url()).hostname;
  if (passive && !passiveLoaded) {
    const helper = context.serviceWorkers().find(item => item.url() !== worker.url() && item.url().endsWith('/background.js'));
    assert.ok(helper, 'Passive filename extension worker must be loaded.');
    passiveLoaded = { id: new URL(helper.url()).hostname, worker: helper };
  }
  if (passive) assert.equal(await passiveLoaded.worker.evaluate(() => chrome.downloads.onDeterminingFilename.hasListeners()), true);
  console.log(`原生 Chrome 下载文件名回归：${passive ? '被动下载命名扩展已启用' : '无其他命名监听扩展'}`);
  const page = await context.newPage();
  await page.goto(base);
  const tabId = await worker.evaluate(async baseUrl => (await chrome.tabs.query({})).find(tab => tab.url === `${baseUrl}/`).id, base);
  const popup = await context.newPage();
  await page.bringToFront();
  const errors = [];
  popup.on('pageerror', error => errors.push(error.message));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  // Headless Chrome cannot operate the native Save As dialog. Preserve the UI's
  // export Blob, name preparation and download call, bypassing only that dialog.
  await popup.evaluate(() => {
    const download = chrome.downloads.download.bind(chrome.downloads);
    chrome.downloads.download = options => download({ ...options, saveAs: false });
  });
  await popup.waitForFunction(() => document.querySelector('#page-host').textContent !== '正在读取当前网页…');
  await page.reload();
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await send('GET_STATE', { tabId });
    if (state.streams.some(stream => stream.url.endsWith('/plain.m3u8')) && state.streams.some(stream => stream.url.endsWith('/mime-playlist'))) break;
    if (attempt === 49) {
      console.error('检测诊断', state, await worker.evaluate(async () => ({ permissions: await chrome.permissions.getAll(), tabs: await chrome.tabs.query({}) })));
      throw new Error('自动检测未捕获 URL 和 MIME 播放列表');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log('PASS 自动检测：m3u8 URL + 无扩展名 MIME 播放列表');
  await popup.locator('#streams-tab').click();
  await popup.waitForFunction(() => document.querySelectorAll('.stream-card').length >= 2);
  await popup.screenshot({ path: path.join(results, 'popup.png'), fullPage: true });
  await popup.locator('#auto-save').check();
  await popup.locator('#download-concurrency').selectOption('8');
  await popup.locator('#download-retries').selectOption('3');
  let configured;
  for (let i = 0; i < 30; i++) {
    configured = (await send('GET_STATE', { tabId })).settings;
    if (configured.saveAs === false && configured.concurrency === 8 && configured.retries === 3) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(configured.saveAs, false);
  assert.equal(configured.concurrency, 8);
  assert.equal(configured.retries, 3);
  console.log('PASS 自动保存开关与8路并发/重试设置持久化');

  // Exercise the actual detected-video button and the automatic save preference.
  await popup.locator('.stream-card').filter({ hasText: '/plain.m3u8' }).getByRole('button', { name: /下载 MP4/ }).click();

  const previewEvent = context.waitForEvent('page');
  assert.equal((await send('OPEN_PREVIEW', { url: `${base}/master.m3u8`, title: '测试视频预览', tabId })).ok, true);
  const preview = await previewEvent;
  preview.on('pageerror', error => console.error('Preview page error:', error.message));
  preview.on('console', message => { if (['error', 'warning'].includes(message.type())) console.error('Preview:', message.text()); });
  await preview.waitForLoadState();
  assert.equal(await preview.evaluate(() => MediaSource.isTypeSupported('video/mp4;codecs="avc1.42C00C"')), true,
    '测试浏览器缺少 H.264 解码器。请用 E2E_CHROME_PATH 指定支持 H.264/AAC 的 Chrome。');
  try {
    await preview.waitForFunction(() => document.querySelector('video').readyState >= 2);
  } catch (error) {
    console.error(await preview.evaluate(() => ({ title: document.title, text: document.body.innerText, hls: typeof Hls, readyState: document.querySelector('video').readyState, mediaError: document.querySelector('video').error?.message })));
    await preview.screenshot({ path: path.join(results, 'preview-failure.png'), fullPage: true });
    throw error;
  }
  await preview.evaluate(async () => { const video = document.querySelector('video'); video.muted = true; await video.play(); });
  await preview.waitForFunction(() => document.querySelector('video').currentTime > 0.1);
  await preview.screenshot({ path: path.join(results, 'preview.png'), fullPage: true });
  assert.equal(await preview.locator('#error').isHidden(), true);
  console.log('PASS HLS视频预览实际播放（fMP4 + 独立音轨）');
  await preview.close();

  async function waitJob(jobId, expected = 'complete') {
    let lastStatus;
    for (let attempt = 0; attempt < 900; attempt++) {
      const state = await send('GET_STATE', { tabId });
      const job = state.jobs.find(item => item.id === jobId);
      lastStatus = job && { id: job.id, status: job.status, progress: job.progress, completedSegments: job.completedSegments, totalSegments: job.totalSegments, bytes: job.bytes, error: job.error };
      if (job?.status === expected) return job;
      if (['error', 'cancelled'].includes(job?.status) && job.status !== expected) throw new Error(JSON.stringify(job));
      if (attempt && attempt % 50 === 0) {
        const diagnostic = await send('GET_DIAGNOSTIC', { jobId });
        console.log('等待任务', JSON.stringify({ ...lastStatus, stage: diagnostic.report?.events?.filter(event => event.event === 'stage').at(-1)?.stage, diagnostic: Boolean(diagnostic.report), runtimeErrors: runtimeErrors.slice(-3) }));
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const diagnostic = await send('GET_DIAGNOSTIC', { jobId });
    await writeFile(path.join(results, 'e2e-task-timeout.json'), JSON.stringify({ task: lastStatus, diagnostic, runtimeErrors }, null, 2));
    throw new Error(`任务超时 ${JSON.stringify(lastStatus)}；诊断已保存到test-results/e2e-task-timeout.json`);
  }
  async function namedDownload(job, expected) {
    assert.ok(Number.isInteger(job.downloadId) && job.downloadId >= 0, 'The completed job must own a concrete Chrome download ID.');
    const download = await worker.evaluate(async downloadId => (await chrome.downloads.search({ id: downloadId }))[0], job.downloadId);
    assert.equal(download.state, 'complete');
    assert.equal(path.dirname(download.filename).toLowerCase(), downloadPath.toLowerCase(), 'Chrome native preferences must select the isolated download directory.');
    assert.equal(path.basename(download.filename), expected, 'Final saved filename must preserve the requested title, not a Blob UUID.');
    assert.ok((await stat(download.filename)).size > 1000);
    return download;
  }
  const first = (await send('GET_STATE', { tabId })).jobs.find(job => job.url === `${base}/plain.m3u8`);
  assert.ok(first, '点击下载按钮应创建任务');
  assert.equal(first.saveAs, false);
  await namedDownload(await waitJob(first.id), '流光自动检测测试.mp4');
  console.log('PASS 用户点击下载按钮后按设置自动保存中文标题MP4');
  // Exercise the actual optional filename field instead of passing a title only
  // through START_DOWNLOAD. This catches UI and engine naming regressions.
  await popup.locator('#manual-details').evaluate(element => { element.open = true; });
  await popup.locator('#manual-url').fill(`${base}/plain.m3u8?manual-filename=1`);
  await popup.locator('#manual-title').fill('手填中文文件名 2026');
  await popup.locator('#manual-submit').click();
  let manual;
  for (let attempt = 0; attempt < 50; attempt++) {
    manual = (await send('GET_STATE', { tabId })).jobs.find(job => job.title === '手填中文文件名 2026');
    if (manual) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(manual, 'Manual filename submission must create a job.');
  await namedDownload(await waitJob(manual.id), '手填中文文件名 2026.mp4');
  console.log('PASS 手填中文文件名按原名保存MP4');
  for (const name of ['plain', 'encrypted', 'png-prefixed', 'encrypted-png-prefixed', 'master', 'range', 'retry']) {
    const title = `流光-${name}`;
    const result = await send('START_DOWNLOAD', { tabId, url: `${base}/${name}.m3u8`, title });
    assert.equal(result.ok, true, result.error);
    const job = await waitJob(result.jobId);
    assert.equal(job.saveAs, false);
    if (name === 'retry') { assert.equal(retryRequests, 2); assert.equal(job.retryCount, 1); }
    const download = await namedDownload(job, `${title}.mp4`);
    const probe = JSON.parse(native(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', download.filename], 'ffprobe'));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'video'));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
    assert.ok(Number(probe.format.duration) >= 2.8 && Number(probe.format.duration) < 5);
    native(['-v', 'error', '-i', download.filename, '-f', 'null', '-']);
    if (name.includes('png-prefixed')) {
      assert.equal(job.bytes, plainTSBytes, 'retained media must exclude PNG prefix and AES padding');
      const { ok, report, error } = await send('GET_DIAGNOSTIC', { jobId: result.jobId });
      assert.equal(ok, true, error);
      assert.equal(report.ffmpeg.exitCode, 0);
      const normalized = report.events.filter(event => event.container === 'mpegts' && event.removedPrefixBytes > 0);
      assert.equal(normalized.length, 3);
      assert.ok(normalized.every(event => event.removedPrefixBytes === 70));
      const serialized = JSON.stringify(report);
      for (const forbidden of [new URL(base).hostname, `${base}/${name}.m3u8`, pngPrefix.toString('hex'), pngPrefix.toString('base64')]) {
        assert.equal(serialized.includes(forbidden), false, 'normalization diagnostics must not record addresses or raw media bytes');
      }
    }
    console.log(`PASS ${name}：本地 MP4 已保存，音轨/画面/时长/解码均通过`);
  }
  const onlyImage = await send('START_DOWNLOAD', { tabId, url: `${base}/only-image.m3u8`, title: 'only-image', saveAs: false });
  assert.equal(onlyImage.ok, true, onlyImage.error);
  const imageFailure = await waitJob(onlyImage.jobId, 'error');
  assert.match(imageFailure.error, /图片.*(?:有效|视频)/);
  assert.equal(imageFailure.downloadId, undefined, 'a genuine PNG must never be saved as a successful MP4');
  console.log('PASS image/png真图片无TS：明确拒绝且不会假成功保存MP4');
  for (const name of ['live', 'drm']) {
    const result = await send('START_DOWNLOAD', { tabId, url: `${base}/${name}.m3u8`, title: name, saveAs: false });
    assert.equal(result.ok, true, result.error);
    const job = await waitJob(result.jobId, 'error');
    assert.match(job.error, name === 'live' ? /直播/ : /DRM/);
    console.log(`PASS ${name}：显示明确的不支持原因`);
  }
  const diagnosticFailures = [];
  for (const name of ['pcm', 'html']) {
    const privateTitle = `private-diagnostic-${name}-title-check`;
    const fixtureUrl = `${base}/diagnostic-${name}.m3u8?token=secret-signature-check`;
    const created = await send('START_DOWNLOAD', { tabId, url: fixtureUrl, title: privateTitle, saveAs: false });
    assert.equal(created.ok, true, created.error);
    const failed = await waitJob(created.jobId, 'error');
    assert.ok(failed.error && !/^\s*(?:MP4 合并失败[，。:：\s]*)?Aborted\(\)[.\s]*$/.test(failed.error), 'error must retain the useful FFmpeg cause');
    const diagnostic = await send('GET_DIAGNOSTIC', { jobId: created.jobId });
    assert.equal(diagnostic.ok, true, diagnostic.error);
    const report = diagnostic.report;
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.jobId, created.jobId);
    assert.equal(report.status, 'error');
    assert.deepEqual(Object.keys(report.source).sort(), ['format', 'platform']);
    assert.equal(report.ffmpeg.exitCode, 1);
    assert.ok(report.ffmpeg.logs.length > 0);
    assert.ok(report.ffmpeg.ignoredAbortLines >= 1);
    assert.ok(report.ffmpeg.logs.every(entry => !/^\s*Aborted\(\)\s*$/.test(entry.message)));
    const engineLogs = report.ffmpeg.logs.map(entry => entry.message).join('\n');
    if (name === 'pcm') assert.match(engineLogs, /pcm_bluray.*(?:not currently supported|container)|Could not find tag for codec pcm_bluray/i);
    else assert.match(engineLogs, /Error when loading first segment|Invalid data found when processing input/i);
    assert.ok(report.failure?.message);
    const exported = JSON.stringify(report);
    for (const secret of [new URL(base).hostname, fixtureUrl, 'secret-signature-check', '?token=', privateTitle, `diagnostic-${name}.m3u8`]) {
      assert.equal(exported.includes(secret), false, `diagnostic report leaked private source metadata: ${secret}`);
    }
    diagnosticFailures.push({ id: created.jobId, title: privateTitle, report });
    console.log(`PASS ${name}真实合并失败：保留exitCode/有效日志、过滤裸Aborted()、隐藏视频地址/签名/标题`);
  }
  await popup.locator('#jobs-tab').click();
  await popup.screenshot({ path: path.join(results, 'diagnostic-failures.png'), fullPage: true });
  const recovery = await send('START_DOWNLOAD', { tabId, url: `${base}/plain.m3u8?after-diagnostic-failure=1`, title: 'diagnostic-recovery', saveAs: false });
  assert.equal(recovery.ok, true, recovery.error);
  await namedDownload(await waitJob(recovery.jobId), 'diagnostic-recovery.mp4');
  console.log('PASS 真实合并失败后后续正常HLS仍能完成MP4下载');
  await popup.locator('#jobs-tab').click();
  async function exportedDiagnostic(button, artifactName) {
    const knownIds = await worker.evaluate(async () => (await chrome.downloads.search({ limit: 100, orderBy: ['-startTime'] })).map(item => item.id));
    await button.click();
    for (let attempt = 0; attempt < 100; attempt++) {
      const download = await worker.evaluate(async previous => (await chrome.downloads.search({ limit: 100, orderBy: ['-startTime'] }))
        .find(item => !previous.includes(item.id) && /^application\/json(?:;|$)/i.test(item.mime) && item.state === 'complete'), knownIds);
      if (download) {
        assert.equal(path.dirname(download.filename).toLowerCase(), downloadPath.toLowerCase());
        const exported = JSON.parse(await readFile(download.filename, 'utf8'));
        assert.ok(Array.isArray(exported.reports));
        const serialized = JSON.stringify(exported);
        for (const secret of [new URL(base).hostname, 'secret-signature-check', '?token=', ...diagnosticFailures.map(item => item.title)]) {
          assert.equal(serialized.includes(secret), false, `exported diagnostic file leaked source metadata: ${secret}`);
        }
        assert.doesNotMatch(serialized, /localhost|127\.0\.0\.1/i);
        await mkdir(path.join(results, 'diagnostics'), { recursive: true });
        await writeFile(path.join(results, 'diagnostics', artifactName), JSON.stringify(exported, null, 2));
        return exported;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const recent = await worker.evaluate(async previous => (await chrome.downloads.search({ limit: 20, orderBy: ['-startTime'] }))
      .filter(item => !previous.includes(item.id)).map(({ id, state, mime, error }) => ({ id, state, mime, error })), knownIds);
    throw new Error(`点击诊断日志导出按钮后未生成完整的JSON下载：${JSON.stringify({ recent, notice: await popup.locator('#notice').textContent() })}`);
  }
  const individual = await exportedDiagnostic(popup.locator(`button[data-diagnostic-job-id="${diagnosticFailures[0].id}"]`), 'individual.json');
  assert.equal(individual.reports.length, 1);
  assert.equal(individual.reports[0].jobId, diagnosticFailures[0].id);
  assert.equal(individual.reports[0].ffmpeg.exitCode, 1);
  const allDiagnostics = await exportedDiagnostic(popup.locator('#export-diagnostics'), 'all.json');
  for (const failure of diagnosticFailures) assert.ok(allDiagnostics.reports.some(report => report.jobId === failure.id));
  console.log('PASS 单任务/全局诊断导出按钮生成可读取JSON且不含视频地址、域名、签名或标题');
  const direct = await send('START_DOWNLOAD', { tabId, url: `${base}/plain.mp4`, title: '直链视频', saveAs: false });
  assert.equal(direct.ok, true, direct.error);
  const directJob = await waitJob(direct.jobId);
  assert.equal(directJob.format, 'mp4');
  const directFile = (await namedDownload(directJob, '直链视频.mp4')).filename;
  const directProbe = JSON.parse(native(['-v', 'error', '-show_streams', '-of', 'json', directFile], 'ffprobe'));
  assert.ok(directProbe.streams.some(stream => stream.codec_type === 'video'));
  assert.ok(directProbe.streams.some(stream => stream.codec_type === 'audio'));
  console.log('PASS MP4 文件流式下载及音画验证');
  const invalid = await send('START_DOWNLOAD', { tabId, url: `${base}/invalid.mp4`, title: 'invalid-mp4', saveAs: false });
  assert.equal(invalid.ok, true, invalid.error);
  assert.match((await waitJob(invalid.jobId, 'error')).error, /有效的 MP4/);
  console.log('PASS 拒绝伪装成 MP4 的网页响应');
  const slow = await send('START_DOWNLOAD', { tabId, url: `${base}/slow.m3u8`, title: 'cancel', saveAs: false });
  await gate;
  assert.equal((await send('CANCEL_JOB', { jobId: slow.jobId })).ok, true);
  await waitJob(slow.jobId, 'cancelled');
  holdSlow = false;
  const next = await send('START_DOWNLOAD', { tabId, url: `${base}/slow.m3u8`, title: 'after-cancel', saveAs: false });
  await namedDownload(await waitJob(next.jobId), 'after-cancel.mp4');
  console.log('PASS 取消任务后可继续下载下一项');
  await popup.locator('#jobs-tab').click();
  await popup.screenshot({ path: path.join(results, 'jobs.png'), fullPage: true });
  // Closing the UI must not cancel an offscreen task or its local save.
  holdSlow = true;
  const continued = await send('START_DOWNLOAD', { tabId, url: `${base}/slow.m3u8?continue=1`, title: 'closed-popup' });
  await popup.close();
  await new Promise(resolve => setTimeout(resolve, 500));
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${id}/popup.html`);
  await reopened.waitForFunction(() => document.querySelector('#page-host').textContent !== '正在读取当前网页…');
  assert.equal(await reopened.locator('#auto-save').isChecked(), true);
  assert.equal(await reopened.locator('#download-concurrency').inputValue(), '8');
  for (let i = 0; i < 100; i++) {
    const state = await reopened.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE' }));
    const job = state.jobs.find(item => item.id === continued.jobId);
    if (job?.status === 'complete') { await namedDownload(job, 'closed-popup.mp4'); break; }
    assert.notEqual(job?.status, 'error', job?.error);
    if (i === 99) throw new Error('关闭弹窗后下载未完成');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  console.log('PASS 关闭弹窗后任务继续；重新打开保留自动保存/并发设置');
  await assertForeignFilename(context, cdp, passiveExtension, passiveLoaded);
  console.log('PASS 本插件不改名其他扩展自己的下载');
  assert.equal(await worker.evaluate(() => chrome.downloads.onDeterminingFilename.hasListeners()), false, 'Automatic MP4 saving must not install a global filename listener.');
  if (passiveLoaded) assert.ok(await passiveLoaded.worker.evaluate(() => globalThis.filenameEvents) > 0);

  await testStreamTitles({ context, worker, mainPage: page, base, extensionId: id, tabId, namedDownload,
    onPageError: error => errors.push(error.message), screenshotsDirectory: results });

  // Job deletion changes history only; downloaded files belong to the user.
  let jobsPage = reopened;
  jobsPage.on('pageerror', error => errors.push(error.message));
  const jobsSend = (type, data = {}) => jobsPage.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  async function observeRenameRequests() {
    await jobsPage.evaluate(() => {
      globalThis.inlineRenameRequests = [];
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (...args) => {
        if (args[0]?.type === 'RENAME_JOB') globalThis.inlineRenameRequests.push(args[0].jobId);
        return send(...args);
      };
    });
  }
  await observeRenameRequests();
  async function waitJobs(predicate, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await jobsSend('GET_STATE', { tabId });
      if (predicate(state.jobs)) return state.jobs;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
  }
  async function reopenJobs() {
    await jobsPage.close();
    jobsPage = await context.newPage();
    jobsPage.on('pageerror', error => errors.push(error.message));
    await jobsPage.goto(`chrome-extension://${id}/popup.html`);
    await jobsPage.locator('#jobs-tab').click();
    await jobsPage.waitForFunction(() => document.querySelector('#page-host').textContent !== '正在读取当前网页…');
    await observeRenameRequests();
  }
  async function assertEmptyJobs() {
    await waitJobs(jobs => jobs.length === 0, '任务列表清空后后台仍保留记录');
    await jobsPage.waitForFunction(() => document.querySelectorAll('.job-card').length === 0 &&
      !document.querySelector('#jobs-empty').hidden && document.querySelector('#clear-jobs').disabled &&
      document.querySelector('#jobs-count').textContent === '0');
  }
  await jobsPage.locator('#jobs-tab').click();
  const savedSize = (await stat(directFile)).size;
  const titleButton = jobId => jobsPage.locator(`button.job-title-button[data-rename-job-id="${jobId}"]`);
  const titleInput = jobId => jobsPage.locator(`input.job-title-input[data-rename-job-id="${jobId}"]`);
  async function waitTitle(jobId, title) {
    await waitJobs(jobs => jobs.some(job => job.id === jobId && job.title === title), '编辑任务名称后后台标题未更新');
    await jobsPage.waitForFunction(({ jobId, title }) =>
      document.querySelector(`button.job-title-button[data-rename-job-id="${jobId}"]`)?.textContent === title, { jobId, title });
  }
  assert.equal(await titleInput(directJob.id).count(), 0, '任务名称默认应显示静态文本按钮');
  assert.equal(await titleButton(directJob.id).textContent(), '直链视频');
  await titleButton(directJob.id).click();
  await titleInput(directJob.id).fill('本地文件新名称 Enter');
  const pageCountBeforeAuthorization = context.pages().length;
  await titleInput(directJob.id).press('Enter');
  const inlineAuthorization = jobsPage.locator(`.job-card[data-job-id="${directJob.id}"] .local-rename-prompt`);
  await inlineAuthorization.waitFor();
  assert.match(await inlineAuthorization.textContent(), /本地文件新名称 Enter\.mp4/);
  assert.equal(context.pages().length, pageCountBeforeAuthorization, '目录授权必须在弹窗卡片中，不打开独立页面');
  await waitTitle(directJob.id, '直链视频');
  assert.equal((await stat(directFile)).size, savedSize);
  await titleButton(directJob.id).click();
  await titleInput(directJob.id).fill('本地文件新名称 失焦');
  await jobsPage.locator('#jobs-tab').click();
  await inlineAuthorization.waitFor();
  assert.match(await inlineAuthorization.textContent(), /本地文件新名称 失焦\.mp4/);
  assert.equal(context.pages().length, pageCountBeforeAuthorization);
  await waitTitle(directJob.id, '直链视频');
  const committedRenameCount = await jobsPage.evaluate(() => globalThis.inlineRenameRequests.length);
  await titleButton(directJob.id).click();
  await titleInput(directJob.id).fill('Esc 放弃的名称');
  await titleInput(directJob.id).press('Escape');
  await waitTitle(directJob.id, '直链视频');
  assert.equal(await jobsPage.evaluate(() => globalThis.inlineRenameRequests.length), committedRenameCount, 'Esc不能提交RENAME_JOB');
  const savedDownload = await worker.evaluate(async downloadId => (await chrome.downloads.search({ id: downloadId }))[0], directJob.downloadId);
  assert.equal(savedDownload.filename, directFile, '未完成文件夹授权前不能改变原文件路径');
  assert.equal((await stat(directFile)).size, savedSize);
  console.log('PASS 行内名称：默认静态/Enter与失焦在卡片内授权/Esc取消；无新页面，授权前原任务名称与MP4保留');

  const renamedActiveId = await startHeld('rename');
  await titleButton(renamedActiveId).click();
  const activeInput = titleInput(renamedActiveId);
  await activeInput.fill('进行中改名后');
  await activeInput.evaluate(input => {
    globalThis.inlineInputNode = input;
    input.setSelectionRange(2, 5);
  });
  const previousMeta = await activeInput.locator('xpath=ancestor::article').locator('.job-meta').textContent();
  heldSegments.get('hold-rename.ts').pulse();
  await jobsPage.waitForFunction(({ jobId, previousMeta }) =>
    document.querySelector(`article[data-job-id="${jobId}"] .job-meta`)?.textContent !== previousMeta,
  { jobId: renamedActiveId, previousMeta });
  assert.equal(await activeInput.evaluate(input => input === globalThis.inlineInputNode && document.activeElement === input), true, '真实进度刷新必须保留同一输入节点和焦点');
  assert.equal(await activeInput.inputValue(), '进行中改名后');
  assert.deepEqual(await activeInput.evaluate(input => [input.selectionStart, input.selectionEnd]), [2, 5]);
  await activeInput.locator('xpath=ancestor::article').screenshot({ path: path.join(results, 'job-name-edit.png') });
  await activeInput.press('Enter');
  await waitTitle(renamedActiveId, '进行中改名后');
  // Hold the actual offscreen SAVE_BLOB handoff briefly. Conversion still runs
  // normally, providing a deterministic saving state that is otherwise too fast
  // to inspect in an automatic download.
  await evaluateExtensionDocument(cdp, id, 'offscreen.html', `(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message.type === 'SAVE_BLOB' && message.jobId === ${JSON.stringify(renamedActiveId)}) {
        chrome.runtime.sendMessage = send;
        return new Promise((resolve, reject) => {
          globalThis.releaseInlineSaving = () => { send(message, ...args).then(resolve, reject); return true; };
        });
      }
      return send(message, ...args);
    };
    return true;
  })()`);
  heldSegments.get('hold-rename.ts').release();
  await waitJobs(jobs => jobs.some(job => job.id === renamedActiveId && job.status === 'saving'), '测试任务未进入保存阶段');
  await jobsPage.waitForFunction(jobId => document.querySelector(`button.job-title-button[data-rename-job-id="${jobId}"]`)?.disabled, renamedActiveId);
  await titleButton(renamedActiveId).evaluate(button => button.click());
  assert.equal(await titleInput(renamedActiveId).count(), 0, 'saving阶段不能开启编辑器');
  assert.equal((await jobsSend('RENAME_JOB', { jobId: renamedActiveId, title: '保存阶段不应接受的名字' })).ok, false);
  await evaluateExtensionDocument(cdp, id, 'offscreen.html', 'globalThis.releaseInlineSaving()');
  const renamedJobs = await waitJobs(jobs => jobs.some(job => job.id === renamedActiveId && job.status === 'complete'), '改名任务未完成保存');
  await namedDownload(renamedJobs.find(job => job.id === renamedActiveId), '进行中改名后.mp4');
  assert.equal(await stat(path.join(downloadPath, '删除测试-rename.mp4')).catch(() => null), null, '活动任务不能仍以旧标题保存');
  await jobsPage.waitForFunction(jobId => document.querySelector(`article[data-job-id="${jobId}"] .job-state`)?.classList.contains('complete'), renamedActiveId);
  await titleButton(renamedActiveId).locator('xpath=ancestor::article').screenshot({ path: path.join(results, 'job-name-static.png') });
  console.log('PASS 活动改名：真实进度刷新保留输入/草稿/选区，保存阶段禁编辑，最终以新名落盘');

  const beforeRemoval = (await jobsSend('GET_STATE', { tabId })).jobs.length;
  const removeCompleted = jobsPage.locator(`.job-remove-button[data-remove-job-id="${directJob.id}"]`);
  const completedCard = removeCompleted.locator('xpath=ancestor::article');
  await removeCompleted.scrollIntoViewIfNeeded();
  await jobsPage.mouse.move(1, 1);
  await jobsPage.locator('#jobs-tab').focus();
  await jobsPage.waitForFunction(jobId => {
    const button = document.querySelector(`.job-remove-button[data-remove-job-id="${jobId}"]`);
    return button && Number(getComputedStyle(button).opacity) === 0;
  }, directJob.id);
  await completedCard.hover();
  await jobsPage.waitForFunction(jobId => Number(getComputedStyle(document.querySelector(`.job-remove-button[data-remove-job-id="${jobId}"]`)).opacity) >= 0.99, directJob.id);
  const cardBox = await completedCard.boundingBox();
  const removeBox = await removeCompleted.boundingBox();
  assert.ok(removeBox.x + removeBox.width >= cardBox.x + cardBox.width - 48 && removeBox.y < cardBox.y + 40, '删除按钮应位于任务卡右上角');
  await completedCard.screenshot({ path: path.join(results, 'job-remove-hover.png') });
  await jobsPage.mouse.move(1, 1);
  await jobsPage.locator('#clear-jobs').focus();
  let reachedRemove = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    await jobsPage.keyboard.press('Tab');
    if (await removeCompleted.evaluate(button => document.activeElement === button)) { reachedRemove = true; break; }
  }
  assert.ok(reachedRemove, '键盘 Tab 应能到达每卡的删除按钮');
  assert.equal(await removeCompleted.evaluate(button => button.matches(':focus-visible')), true);
  await jobsPage.waitForFunction(jobId => Number(getComputedStyle(document.querySelector(`.job-remove-button[data-remove-job-id="${jobId}"]`)).opacity) >= 0.99, directJob.id);
  await removeCompleted.click();
  await waitJobs(jobs => !jobs.some(job => job.id === directJob.id), '删除已完成任务后记录仍存在');
  await jobsPage.waitForFunction(count => document.querySelectorAll('.job-card').length === count &&
    document.querySelector('#jobs-count').textContent === String(count), beforeRemoval - 1);
  assert.equal((await stat(directFile)).size, savedSize, '删除任务记录不能删除已保存的MP4');
  await reopenJobs();
  assert.equal((await jobsSend('GET_STATE', { tabId })).jobs.some(job => job.id === directJob.id), false);
  assert.equal(await jobsPage.locator(`.job-remove-button[data-remove-job-id="${directJob.id}"]`).count(), 0);
  console.log('PASS 每卡删除：默认隐藏/悬停显示/键盘可达；删除完成记录与计数持久化且MP4保留');

  await jobsPage.locator('#clear-jobs').click();
  await assertEmptyJobs();
  await reopenJobs();
  await assertEmptyJobs();
  console.log('PASS 清空任务历史：空列表/禁用按钮/零计数正确，重新打开不会恢复');

  async function startHeld(name) {
    const created = await jobsSend('START_DOWNLOAD', { tabId, url: `${base}/hold-${name}.m3u8`, title: `删除测试-${name}`, saveAs: false });
    assert.equal(created.ok, true, created.error);
    await waitJobs(jobs => heldSegments.get(`hold-${name}.ts`)?.started &&
      jobs.some(job => job.id === created.jobId && job.status === 'downloading'), '用于删除测试的下载未进入真实传输状态');
    return created.jobId;
  }
  async function assertHeldAborted(name) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (heldSegments.get(`hold-${name}.ts`)?.aborted) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('移除活动任务后网络连接仍在传输');
  }
  const deletedActiveId = await startHeld('delete');
  await titleButton(deletedActiveId).click();
  await titleInput(deletedActiveId).fill('删除时不得提交的草稿');
  const beforeDeleteDraft = await jobsPage.evaluate(() => globalThis.inlineRenameRequests.length);
  const removeActive = jobsPage.locator(`.job-remove-button[data-remove-job-id="${deletedActiveId}"]`);
  await removeActive.locator('xpath=ancestor::article').hover();
  await removeActive.click();
  await assertHeldAborted('delete');
  assert.equal(await jobsPage.evaluate(() => globalThis.inlineRenameRequests.length), beforeDeleteDraft, '点删除不能先因blur提交草稿');
  await assertEmptyJobs();
  await reopenJobs();
  await assertEmptyJobs();
  console.log('PASS 删除进行中任务：实际网络传输取消且记录不再出现');

  const clearActiveId = await startHeld('clear');
  const queuedAfterHeld = await jobsSend('START_DOWNLOAD', { tabId, url: `${base}/hold-queued.m3u8`, title: '清空队列测试', saveAs: false });
  assert.equal(queuedAfterHeld.ok, true, queuedAfterHeld.error);
  await waitJobs(jobs => jobs.length === 2 && jobs.some(job => job.id === queuedAfterHeld.jobId), '清空队列测试未创建第二个任务');
  await titleButton(clearActiveId).click();
  await titleInput(clearActiveId).fill('清空时不得提交的草稿');
  const beforeClearDraft = await jobsPage.evaluate(() => globalThis.inlineRenameRequests.length);
  await jobsPage.locator('#clear-jobs').click();
  await assertHeldAborted('clear');
  assert.equal(await jobsPage.evaluate(() => globalThis.inlineRenameRequests.length), beforeClearDraft, '点清空不能先因blur提交草稿');
  await assertEmptyJobs();
  await new Promise(resolve => setTimeout(resolve, 500));
  if (heldSegments.get('hold-queued.ts')?.started) await assertHeldAborted('queued');
  await reopenJobs();
  await assertEmptyJobs();
  assert.equal((await stat(directFile)).size, savedSize, '清空任务列表不能删除已保存的MP4');
  await jobsPage.screenshot({ path: path.join(results, 'jobs-cleared.png'), fullPage: true });
  console.log('PASS 含活动/排队任务的清空：取消传输、停止队列、不恢复记录并保留已有文件');
  assert.deepEqual(errors, []);
  console.log(`E2E 全部通过，截图：${results}`);
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
