import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = path.join(root, 'test-results', 'large');
const fixtures = path.join(results, 'fixtures');
const profile = path.join(root, `.large-test-profile-${Date.now()}`);
const extension = path.join(root, 'dist', 'liuguang-m3u8');
const targetGiB = Number(process.env.E2E_LARGE_GIB || 2.1);
assert.ok(Number.isFinite(targetGiB) && targetGiB > 0, 'E2E_LARGE_GIB must be a positive number.');
const targetBytes = Math.ceil(targetGiB * 1024 ** 3);
const timeoutMs = Number(process.env.E2E_LARGE_TIMEOUT_MS || 20 * 60 * 1000);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, 'E2E_LARGE_TIMEOUT_MS must be positive.');
await mkdir(fixtures, { recursive: true });

function native(args, program = 'ffmpeg', timeout = 5 * 60 * 1000) {
  const execution = spawnSync(program, args, {
    encoding: 'utf8', cwd: fixtures, windowsHide: true,
    timeout, maxBuffer: 2 * 1024 * 1024
  });
  if (execution.error || execution.status !== 0) {
    throw new Error(`${program}: ${execution.error?.message || execution.stderr || `exit ${execution.status}`}`);
  }
  return execution.stdout;
}

const common = ['-hide_banner', '-loglevel', 'error', '-y'];
console.log(`Preparing a real HLS download with at least ${targetGiB} GiB of MP4 output.`);
native([...common,
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '24',
  '-c:a', 'aac', '-f', 'mpegts', 'sample.ts'
]);
// Reuse a moderate disk-backed block rather than creating a multi-GB fixture.
// Repeating it through distinct HLS URIs exercises the extension's full path.
const loops = Number(process.env.E2E_LARGE_BLOCK_LOOPS || 900);
assert.ok(Number.isSafeInteger(loops) && loops > 0, 'E2E_LARGE_BLOCK_LOOPS must be a positive integer.');
native([...common, '-stream_loop', String(loops - 1), '-i', 'sample.ts', '-map', '0', '-c', 'copy', '-f', 'mpegts', 'block.ts']);
native([...common, '-i', 'block.ts', '-map', '0', '-c', 'copy', '-movflags', '+faststart', 'block.mp4']);
const blockPath = path.join(fixtures, 'block.ts');
const blockBytes = (await stat(blockPath)).size;
const blockMP4Bytes = (await stat(path.join(fixtures, 'block.mp4'))).size;
const blockProbe = JSON.parse(native(['-v', 'error', '-show_format', '-show_streams', '-of', 'json', 'block.mp4'], 'ffprobe'));
const blockDuration = Number(blockProbe.format.duration);
assert.ok(blockMP4Bytes > 1024 && blockDuration > 0);
const repeatCount = Math.ceil(targetBytes / blockMP4Bytes) + 1;
const manifest = [
  '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-PLAYLIST-TYPE:VOD',
  '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-TARGETDURATION:${Math.ceil(blockDuration)}`,
  ...Array.from({ length: repeatCount }, (_, index) => [
    ...(index ? ['#EXT-X-DISCONTINUITY'] : []),
    `#EXTINF:${blockDuration.toFixed(6)},`, `block.ts?part=${index}`
  ]).flat(),
  '#EXT-X-ENDLIST', ''
].join('\n');
await writeFile(path.join(fixtures, 'large.m3u8'), manifest);
console.log(JSON.stringify({ blockBytes, blockMP4Bytes, blockDuration, repeatCount, expectedInputBytes: blockBytes * repeatCount }));

let servedBytes = 0;
let segmentRequests = 0;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    response.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === '/') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>流光大文件测试</title><h1>真实多 GB 下载测试</h1>');
      return;
    }
    if (url.pathname === '/large.m3u8') {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.setHeader('Content-Length', Buffer.byteLength(manifest));
      response.end(manifest);
      return;
    }
    if (url.pathname !== '/block.ts') { response.writeHead(404).end(); return; }
    segmentRequests++;
    let start = 0, end = blockBytes - 1;
    if (request.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!range) { response.writeHead(416).end(); return; }
      start = Number(range[1]); end = range[2] ? Number(range[2]) : end;
      if (start > end || end >= blockBytes) { response.writeHead(416).end(); return; }
      response.statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${blockBytes}`);
    }
    response.setHeader('Content-Type', 'video/mp2t');
    response.setHeader('Content-Length', end - start + 1);
    const source = createReadStream(blockPath, { start, end, highWaterMark: 64 * 1024 });
    source.on('data', chunk => { servedBytes += chunk.byteLength; });
    // pipeline applies network backpressure; no complete segment is buffered.
    await pipeline(source, response);
  } catch (error) {
    if (['ERR_STREAM_PREMATURE_CLOSE', 'ECONNRESET'].includes(error.code)) return;
    if (!response.headersSent) response.writeHead(500).end();
    else response.destroy(error);
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
if (await stat(path.join(root, '.cache', 'ms-playwright')).catch(() => null)) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
}
const { chromium } = await import('playwright');
const systemChrome = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '';
const chromePath = process.env.E2E_CHROME_PATH || (systemChrome && await stat(systemChrome).catch(() => null) ? systemChrome : undefined);
let context;
let browserCDP;
let startedAt;
const summary = { targetGiB, targetBytes, blockBytes, blockMP4Bytes, blockDuration, repeatCount };
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(chromePath ? { executablePath: chromePath, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }),
    headless: true,
    args: chromePath ? ['--enable-unsafe-extension-debugging'] : [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    acceptDownloads: true, downloadsPath: path.join(results, 'downloads'), viewport: { width: 440, height: 720 }
  });
  browserCDP = await context.browser().newBrowserCDPSession();
  if (chromePath) await browserCDP.send('Extensions.loadUnpacked', { path: extension });
  summary.browserVersion = (await browserCDP.send('Browser.getVersion')).product;
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js')) || await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).hostname;
  const page = await context.newPage();
  await page.goto(base);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === `${url}/`).id, base);
  const popup = await context.newPage();
  const pageErrors = [];
  popup.on('pageerror', error => pageErrors.push(error.message));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  assert.equal((await send('SAVE_SETTINGS', { settings: { saveAs: false, concurrency: 4, retries: 3 } })).ok, true);
  // Use the actual trusted extension page, not service-worker-internal dispatch.
  startedAt = Date.now();
  const start = await send('START_DOWNLOAD', { tabId, url: `${base}/large.m3u8`, title: `large-${targetGiB}GiB-${startedAt}`, saveAs: false });
  assert.equal(start.ok, true, start.error);
  summary.jobId = start.jobId;
  let lastLogAt = 0;
  let lastStatus = '';
  let finalJob;
  while (Date.now() - startedAt < timeoutMs) {
    const state = await send('GET_STATE', { tabId });
    assert.equal(state.ok, true, state.error);
    const job = state.jobs.find(item => item.id === start.jobId);
    assert.ok(job, 'Created job disappeared.');
    if (job.status !== lastStatus || Date.now() - lastLogAt >= 5000) {
      lastStatus = job.status; lastLogAt = Date.now();
      console.log(JSON.stringify({ elapsedSeconds: Math.round((Date.now() - startedAt) / 1000), status: job.status,
        progress: job.progress, bytes: job.bytes, completedSegments: job.completedSegments,
        totalSegments: job.totalSegments, servedBytes }));
    }
    if (['error', 'cancelled'].includes(job.status)) throw new Error(JSON.stringify(job));
    if (job.status === 'complete') { finalJob = job; break; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(finalJob, `Large download timed out after ${timeoutMs / 1000} seconds.`);
  summary.downloadElapsedSeconds = (Date.now() - startedAt) / 1000;
  const download = await worker.evaluate(async downloadId => (await chrome.downloads.search({ id: downloadId }))[0], finalJob.downloadId);
  assert.equal(download.state, 'complete');
  const outputStat = await stat(download.filename);
  assert.ok(outputStat.size >= targetBytes, `MP4 is ${outputStat.size} bytes; expected at least ${targetBytes}.`);
  summary.outputBytes = outputStat.size;
  summary.outputGiB = outputStat.size / 1024 ** 3;
  summary.outputPath = download.filename;
  const probe = JSON.parse(native(['-v', 'error', '-show_streams', '-show_format', '-of', 'json', download.filename], 'ffprobe'));
  assert.ok(probe.streams.some(stream => stream.codec_type === 'video'), 'Missing video track.');
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'), 'Missing audio track.');
  const duration = Number(probe.format.duration);
  assert.ok(Number.isFinite(duration) && duration > blockDuration * (repeatCount - 1), `Unexpected duration: ${duration}.`);
  // Decode only the tail; decoding every frame of the many-hour fixture would
  // turn a disk I/O regression test into an unrelated long CPU benchmark.
  native(['-v', 'error', '-sseof', '-0.3', '-i', download.filename, '-t', '0.2', '-f', 'null', '-']);
  summary.duration = duration;
  summary.streams = probe.streams.map(stream => ({ codecType: stream.codec_type, codecName: stream.codec_name, duration: stream.duration }));
  let remainingCache;
  for (let attempt = 0; attempt < 100; attempt++) {
    remainingCache = await popup.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      let cache;
      try { cache = await root.getDirectoryHandle('liuguang-download-cache-v1'); }
      catch (error) { if (error.name === 'NotFoundError') return []; throw error; }
      const names = [];
      for await (const name of cache.keys()) names.push(name);
      return names;
    });
    if (!remainingCache.length) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.deepEqual(remainingCache, [], 'OPFS staging cache was not cleaned after download completion.');
  assert.deepEqual(pageErrors, []);
  summary.ok = true;
  summary.cacheCleaned = true;
  summary.servedBytes = servedBytes;
  summary.segmentRequests = segmentRequests;
  console.log(`PASS real ${summary.outputGiB.toFixed(3)} GiB MP4: video, audio, duration, tail decoding, OPFS cleanup.`);
} catch (error) {
  summary.ok = false;
  summary.error = error.stack || error.message;
  summary.servedBytes = servedBytes;
  summary.segmentRequests = segmentRequests;
  throw error;
} finally {
  summary.elapsedSeconds = startedAt ? (Date.now() - startedAt) / 1000 : undefined;
  await writeFile(path.join(results, 'result.json'), JSON.stringify(summary, null, 2));
  await browserCDP?.detach().catch(() => {});
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
