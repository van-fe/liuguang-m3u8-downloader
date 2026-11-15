import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareNativeDownloads, useNativeDownloads, loadExtension } from './e2e-downloads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectedVersion = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const workspace = path.join(root, 'work', 'concurrency-e2e');
const run = path.join(workspace, String(Date.now()));
const fixtures = path.join(run, 'fixtures');
const profile = path.join(run, 'profile');
const downloads = path.join(run, 'downloads');
const temporary = path.join(run, 'temp');
await Promise.all([fixtures, temporary].map(directory => mkdir(directory, { recursive: true })));
// Keep subprocess scratch space and browser artifacts on the project's E drive.
process.env.TEMP = temporary;
process.env.TMP = temporary;
process.env.npm_config_cache ||= path.join(root, '.cache', 'npm');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('playwright');

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function native(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8', cwd: fixtures, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, TEMP: temporary, TMP: temporary },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
async function waitFor(read, predicate, message, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (predicate(value)) return value;
    await pause(50);
  }
  throw new Error(`${message}: ${JSON.stringify(value)}`);
}

native('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '24',
  '-c:a', 'aac', '-f', 'hls', '-hls_time', '10', '-hls_playlist_type', 'vod',
  path.join(fixtures, 'fixture.m3u8')]);
native('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-i', path.join(fixtures, 'fixture.m3u8'), '-c', 'copy', '-movflags', '+faststart',
  path.join(fixtures, 'fixture.mp4')]);
const segment = await readFile(path.join(fixtures, 'fixture0.ts'));
const mp4 = await readFile(path.join(fixtures, 'fixture.mp4'));
const started = new Set();
const inFlight = new Set();
const gates = new Map();
const aborted = new Set();
let peakStreams = 0;
let automaticRelease = false;
function release(id) {
  const gate = gates.get(id);
  if (gate && !gate.response.destroyed && !gate.response.writableEnded) {
    gate.response.end(gate.bytes.subarray(gate.offset));
  }
}
function serveMedia(request, response) {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (url.pathname === '/page') {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end('<!doctype html><title>并行下载验证</title><h1>本机并行下载测试</h1>');
    return;
  }
  const manifest = /^\/([^/]+)\.m3u8$/.exec(url.pathname);
  if (manifest) {
    response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    response.end(`#EXTM3U\n#EXT-X-TARGETDURATION:3\n#EXTINF:2.000,\n/segment/${manifest[1]}.ts\n#EXT-X-ENDLIST\n`);
    return;
  }
  const media = /^(?:\/segment\/([^/]+)\.ts|\/([^/]+)\.mp4)$/.exec(url.pathname);
  if (!media) { response.writeHead(404).end(); return; }
  const id = media[1] || media[2];
  const bytes = media[1] ? segment : mp4;
  response.writeHead(200, { 'Content-Type': media[1] ? 'video/mp2t' : 'video/mp4', 'Content-Length': bytes.length });
  const offset = Math.min(1024, bytes.length - 1);
  started.add(id);
  inFlight.add(id);
  peakStreams = Math.max(peakStreams, inFlight.size);
  gates.set(id, { response, bytes, offset });
  response.once('close', () => {
    if (!response.writableEnded) aborted.add(id);
    inFlight.delete(id);
    gates.delete(id);
  });
  // Send real media bytes before holding the remaining body. Multiple entries
  // here prove overlapping downloads, rather than merely accepted queue rows.
  response.write(bytes.subarray(0, offset));
  if (automaticRelease) release(id);
}
// Separate origins avoid Chrome's per-origin HTTP/1.1 connection pool limit.
// Any held stream below therefore measures this extension's task scheduling.
const servers = [];
for (let index = 0; index < 13; index++) {
  const server = createServer(serveMedia);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
}
const bases = servers.map(server => `http://127.0.0.1:${server.address().port}`);
const base = bases[0];
let context;
let closed = false;
let popup;
let worker;
const pageErrors = [];
const summary = { passed: false, base, runDirectory: run, files: [] };
try {
  await prepareNativeDownloads(profile, downloads);
  const systemChrome = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '';
  const executablePath = process.env.E2E_CHROME_PATH || (systemChrome && await stat(systemChrome).catch(() => null) ? systemChrome : undefined);
  context = await chromium.launchPersistentContext(profile, {
    ...(executablePath ? { executablePath, ignoreDefaultArgs: ['--disable-extensions'] } : { channel: 'chromium' }),
    headless: true, args: ['--enable-unsafe-extension-debugging'],
    acceptDownloads: true, downloadsPath: downloads, viewport: { width: 440, height: 820 },
    env: { ...process.env, TEMP: temporary, TMP: temporary },
  });
  context.on('weberror', event => pageErrors.push(event.error().message));
  const cdp = await context.browser().newBrowserCDPSession();
  await useNativeDownloads(cdp);
  const loaded = await loadExtension(context, cdp, path.join(root, 'dist', 'liuguang-m3u8'));
  worker = loaded.worker;
  summary.version = await worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(summary.version, expectedVersion);
  const webPage = await context.newPage();
  await webPage.goto(`${base}/page`);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, `${base}/page`);
  popup = await context.newPage();
  await webPage.bringToFront();
  await popup.goto(`chrome-extension://${loaded.id}/popup.html`);
  const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  const getState = () => send('GET_STATE', { tabId });
  await waitFor(getState, state => state.settings?.taskConcurrency === 'unlimited', 'Unlimited task concurrency did not initialize');
  assert.match((await popup.locator('#task-concurrency').textContent()).trim(), /无上限/);
  assert.notEqual(await popup.locator('#task-concurrency').evaluate(node => node.tagName), 'SELECT');
  const staleSettings = await send('SAVE_SETTINGS', { settings: { taskConcurrency: 1 } });
  assert.equal(staleSettings.ok, true, staleSettings.error);
  assert.equal(staleSettings.settings.taskConcurrency, 'unlimited', 'A legacy numeric setting must not restore a task limit');
  await popup.locator('#auto-save').check();
  await waitFor(getState, state => state.settings.saveAs === false, 'Automatic save preference did not persist');
  summary.settingsScreenshot = path.join(run, 'settings.png');
  await popup.locator('section.preferences').screenshot({ path: summary.settingsScreenshot });

  const descriptions = [
    { key: 'hls-a', extension: 'm3u8' }, { key: 'hls-b', extension: 'm3u8' },
    { key: 'cancel-mp4', extension: 'mp4' },
    ...Array.from({ length: 9 }, (_, index) => ({ key: `concurrent-${index + 1}`, extension: 'mp4' })),
  ];
  for (const [index, description] of descriptions.entries()) {
    const response = await send('START_DOWNLOAD', {
      tabId, url: `${bases[index]}/${description.key}.${description.extension}`, title: `并行-${description.key}`, saveAs: false,
    });
    assert.equal(response.ok, true, response.error);
    description.jobId = response.jobId;
  }
  await waitFor(() => [...started], values => values.length === 12, 'All twelve real media streams must begin before any held response is released');
  assert.equal(inFlight.size, 12, 'Downloads must exceed the former eight-task execution cap');
  const initial = await getState();
  assert.equal(initial.jobs.length, 12, 'Queue admission must exceed the former five-task limit');
  assert.equal(initial.jobs.filter(job => job.status === 'queued').length, 0);
  assert.equal((await worker.evaluate(async () => (await chrome.storage.session.get('jobs')).jobs)).length, 12);
  summary.initial = { activeStreams: inFlight.size, queued: 0, accepted: 12 };

  const staleDuringDownloads = await send('SAVE_SETTINGS', { settings: { taskConcurrency: 1 } });
  assert.equal(staleDuringDownloads.settings.taskConcurrency, 'unlimited');
  const additional = { key: 'after-stale-setting', extension: 'mp4' };
  const additionalResponse = await send('START_DOWNLOAD', {
    tabId, url: `${bases[12]}/${additional.key}.mp4`, title: `并行-${additional.key}`, saveAs: false,
  });
  assert.equal(additionalResponse.ok, true, additionalResponse.error);
  additional.jobId = additionalResponse.jobId;
  descriptions.push(additional);
  await waitFor(() => [...started], values => values.includes(additional.key), 'A stale numeric setting must not throttle a new download');
  assert.equal(inFlight.size, 13);
  assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings)).taskConcurrency, 'unlimited');
  const cancellation = await send('CANCEL_JOB', { jobId: descriptions[2].jobId });
  assert.equal(cancellation.ok, true, cancellation.error);
  await waitFor(() => aborted.has('cancel-mp4'), Boolean, 'Cancellation did not abort only its network stream');
  assert.ok(descriptions.filter(item => item.key !== 'cancel-mp4').every(item => inFlight.has(item.key)));
  await pause(250);
  assert.equal(inFlight.size, 12, 'Cancelling one job must leave all other media streams running');
  summary.unlimited = { simultaneousStreamsBeforeRelease: 13, staleNumericSettingIgnored: true, cancellationIsolated: true };
  automaticRelease = true;
  for (const key of [...gates.keys()]) release(key);

  const final = await waitFor(getState, state => {
    for (const job of state.jobs) {
      if (job.id !== descriptions[2].jobId && ['error', 'cancelled'].includes(job.status)) throw new Error(`${job.title}: ${job.error || job.status}`);
    }
    return state.jobs.filter(job => job.status === 'complete').length === 12;
  }, 'Concurrent jobs did not all finish', 120000);
  assert.equal(final.jobs.find(job => job.id === descriptions[2].jobId).status, 'cancelled');
  const downloadIds = new Set();
  for (const description of descriptions.filter(item => item.key !== 'cancel-mp4')) {
    const job = final.jobs.find(item => item.id === description.jobId);
    assert.ok(Number.isInteger(job.downloadId));
    downloadIds.add(job.downloadId);
    const item = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], job.downloadId);
    assert.equal(item.state, 'complete');
    assert.equal(path.basename(item.filename), `并行-${description.key}.mp4`);
    assert.equal(path.dirname(item.filename).toLowerCase(), downloads.toLowerCase());
    const media = JSON.parse(native('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', item.filename]));
    assert.ok(media.streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264'));
    assert.ok(media.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    assert.ok(Number(media.format.duration) >= 1.9);
    native('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', item.filename, '-f', 'null', '-']);
    summary.files.push({ key: description.key, filename: path.basename(item.filename), bytes: (await stat(item.filename)).size, duration: Number(media.format.duration) });
  }
  assert.equal(downloadIds.size, 12, 'Concurrent jobs must own distinct browser download IDs');
  assert.deepEqual(pageErrors, []);
  summary.peakNetworkStreams = peakStreams;
  summary.completed = 12;
  summary.cancelled = 1;
  summary.pageErrors = pageErrors;
  summary.passed = true;
  console.log('PASS unlimited downloads: 13 simultaneous real media streams; stale numeric limit ignored; 12 complete + 1 isolated cancellation; all MP4 files decode');
} catch (error) {
  summary.error = error.stack || error.message;
  summary.startedMediaStreams = [...started];
  summary.activeMediaStreams = [...inFlight];
  summary.pageErrors = pageErrors;
  if (worker) summary.workerState = await worker.evaluate(async () => ({
    session: await chrome.storage.session.get(['jobs']), settings: await chrome.storage.local.get('settings'),
  })).catch(failure => ({ error: failure.message }));
  throw error;
} finally {
  automaticRelease = true;
  for (const key of [...gates.keys()]) release(key);
  if (context) {
    await context.close();
    closed = true;
  }
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await writeFile(path.join(run, 'result.json'), JSON.stringify(summary, null, 2));
  await writeFile(path.join(workspace, 'latest-result.json'), JSON.stringify(summary, null, 2));
  // Delete only this completed run's generated directories. Retain failed media
  // fixtures for diagnosis; a successful run keeps just its JSON and screenshot.
  if (closed) for (const target of [profile, temporary, ...(summary.passed ? [fixtures, downloads] : [])]) {
    const resolved = path.resolve(target);
    assert.ok(resolved.startsWith(path.resolve(run) + path.sep) && resolved.startsWith(path.resolve(workspace) + path.sep));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(`Result: ${path.join(run, 'result.json')}`);
}
