import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareNativeDownloads, useNativeDownloads, loadExtension } from './e2e-downloads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const publisher = JSON.parse(await readFile(path.join(root, 'store', 'publisher.json'), 'utf8'));
const archive = path.join(root, 'dist', 'chrome-web-store', `liuguang-m3u8-${version}.zip`);
const workspace = path.join(root, 'work', 'store-smoke');
const run = path.join(workspace, String(Date.now()));
const extracted = path.join(run, 'extension');
const temporary = path.join(run, 'temp');
const profile = path.join(run, 'profile');
const downloads = path.join(run, 'downloads');
await Promise.all([temporary, extracted].map(directory => mkdir(directory, { recursive: true })));
process.env.TEMP = temporary;
process.env.TMP = temporary;
process.env.npm_config_cache = path.join(root, '.cache', 'npm');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('playwright');
const report = { passed: false, version, uploadZip: archive, uploadZipSha256: createHash('sha256').update(await readFile(archive)).digest('hex'), urls: [], downloads: [], screenshots: [], pageErrors: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function native(program, args) {
  const result = spawnSync(program, args, { cwd: run, encoding: 'utf8', windowsHide: true, env: { ...process.env }, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
native('python', ['-c', `import pathlib,sys,zipfile
target=pathlib.Path(sys.argv[2]).resolve()
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 assert 'manifest.json' in z.namelist()
 for member in z.infolist():
  name=member.filename
  assert '\\\\' not in name and ':' not in name and not name.startswith('/'),name
  dest=(target/name).resolve()
  assert dest.is_relative_to(target),name
 z.extractall(target)
`, archive, extracted]);
const unpackedManifest = JSON.parse(await readFile(path.join(extracted, 'manifest.json'), 'utf8'));
assert.equal(unpackedManifest.manifest_version, 3);
assert.equal(unpackedManifest.version, version);
assert.equal(unpackedManifest.homepage_url, publisher.homepageUrl);
let context;
let closed = false;
async function waitFor(read, predicate, label, timeout = 60000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await pause(100);
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
async function checkUrl(url, { method = 'GET', text } = {}) {
  const response = await fetch(url, { method, redirect: 'follow', signal: AbortSignal.timeout(45000) });
  assert.equal(response.status, 200, `${method} ${url}`);
  const item = { url, status: response.status, finalUrl: response.url };
  if (text) assert.match(await response.text(), text, url);
  else if (method !== 'HEAD') await response.arrayBuffer();
  report.urls.push(item);
}
async function screenshot(page, filename, { fullPage = false } = {}) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: path.join(run, filename), fullPage });
  const sizing = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(sizing.document <= sizing.viewport + 1, `Page overflow ${filename}: ${JSON.stringify(sizing)}`);
  report.screenshots.push({ filename, ...sizing });
}
try {
  for (const [url, text] of [
    [publisher.homepageUrl, /发现视频/],
    [publisher.privacyUrl, /隐私政策/],
    [publisher.demoUrl, /授权演示/],
    [new URL('sources.html', publisher.homepageUrl).href, /源码/],
    [new URL('sample.m3u8', publisher.demoUrl).href, /#EXTM3U/],
    [new URL('sample-b.m3u8', publisher.demoUrl).href, /#EXTM3U/],
  ]) await checkUrl(url, { text });
  await checkUrl(`${publisher.repositoryUrl}/releases/download/v${version}/liuguang-third-party-sources-${version}.zip`, { method: 'HEAD' });
  await checkUrl(publisher.supportUrl, { method: 'HEAD' });
  await prepareNativeDownloads(profile, downloads);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ignoreDefaultArgs: ['--disable-extensions'], headless: true, args: ['--enable-unsafe-extension-debugging'],
    acceptDownloads: true, downloadsPath: downloads, viewport: { width: 1440, height: 1000 },
    env: { ...process.env, TEMP: temporary, TMP: temporary },
  });
  context.on('weberror', event => report.pageErrors.push(event.error().message));
  const cdp = await context.browser().newBrowserCDPSession();
  await useNativeDownloads(cdp);
  const { id, worker } = await loadExtension(context, cdp, extracted);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), version);
  const publicPage = await context.newPage();
  await publicPage.setViewportSize({ width: 1440, height: 1000 });
  let response = await publicPage.goto(publisher.homepageUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200);
  for (const image of await publicPage.locator('img').all()) {
    await image.scrollIntoViewIfNeeded();
    await image.evaluate(node => node.decode());
  }
  await publicPage.evaluate(() => window.scrollTo(0, 0));
  await screenshot(publicPage, 'homepage-desktop.png', { fullPage: true });
  await publicPage.setViewportSize({ width: 390, height: 844 });
  await screenshot(publicPage, 'homepage-mobile.png', { fullPage: true });
  await publicPage.setViewportSize({ width: 1440, height: 1000 });
  response = await publicPage.goto(publisher.privacyUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200);
  await screenshot(publicPage, 'privacy-desktop.png');
  await publicPage.setViewportSize({ width: 390, height: 844 });
  await screenshot(publicPage, 'privacy-mobile.png');
  await publicPage.setViewportSize({ width: 1280, height: 900 });
  response = await publicPage.goto(publisher.demoUrl, { waitUntil: 'domcontentloaded' });
  assert.equal(response.status(), 200);
  await publicPage.locator('#detect').click();
  await publicPage.waitForFunction(() => document.querySelector('#status').textContent.includes('已读取两个'));
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, publisher.demoUrl);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 440, height: 900 });
  await publicPage.bringToFront();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  const getState = () => send('GET_STATE', { tabId });
  const detected = await waitFor(getState, state => state.streams.filter(stream => stream.url.startsWith(publisher.demoUrl) && stream.url.includes('.m3u8')).length >= 2, 'The public review page did not expose both real HLS sources');
  const [privacy] = await Promise.all([context.waitForEvent('page'), popup.locator('footer a[href="privacy.html"]').click()]);
  await privacy.waitForLoadState('domcontentloaded');
  assert.equal(privacy.url(), `chrome-extension://${id}/privacy.html`);
  assert.equal(await privacy.locator('h1').textContent(), '隐私政策');
  report.localPrivacyFooter = { url: privacy.url(), opened: true };
  await privacy.close();
  await popup.locator('#auto-save').check();
  await waitFor(getState, state => state.settings.saveAs === false, 'Automatic save preference did not persist');
  const hlsUrl = new URL('sample.m3u8', publisher.demoUrl).href;
  const hlsSource = detected.streams.find(stream => stream.url === hlsUrl);
  assert.ok(hlsSource);
  assert.equal((await send('RENAME_STREAM', { tabId, streamId: hlsSource.id, title: '商店验证 · HLS 演示' })).ok, true);
  await popup.locator('#streams-tab').click();
  await popup.locator(`button[data-download-stream-id="${hlsSource.id}"]`).click();
  const mp4Title = '商店验证 · MP4 演示';
  await popup.locator('#manual-details').evaluate(node => { node.open = true; });
  await popup.locator('#manual-url').fill(new URL('demo.mp4', publisher.demoUrl).href);
  await popup.locator('#manual-title').fill(mp4Title);
  await popup.locator('#manual-submit').click();
  const final = await waitFor(getState, state => {
    for (const job of state.jobs) if (['error', 'cancelled'].includes(job.status)) throw new Error(`${job.title}: ${job.error || job.status}`);
    return state.jobs.filter(job => job.status === 'complete').length === 2;
  }, 'Public HLS and MP4 review downloads did not complete', 120000);
  for (const job of final.jobs) {
    const item = await worker.evaluate(async downloadId => (await chrome.downloads.search({ id: downloadId }))[0], job.downloadId);
    assert.equal(item.state, 'complete');
    assert.equal(path.basename(item.filename), `${job.title}.mp4`);
    assert.equal(path.dirname(item.filename).toLowerCase(), downloads.toLowerCase());
    const media = JSON.parse(native('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name:format=duration', '-of', 'json', item.filename]));
    assert.ok(media.streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264'));
    assert.ok(media.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    assert.ok(Number(media.format.duration) >= 3.9);
    native('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', item.filename, '-f', 'null', '-']);
    report.downloads.push({ title: job.title, format: job.format, filename: path.basename(item.filename), bytes: (await stat(item.filename)).size, duration: Number(media.format.duration), fullyDecoded: true });
  }
  await popup.screenshot({ path: path.join(run, 'final-store-package-popup.png'), fullPage: true });
  assert.deepEqual(report.pageErrors, []);
  report.passed = true;
  console.log(`PASS final store package ${version}: public pages and responsive layouts, packaged privacy, actual public HLS/MP4 downloads and complete decoding.`);
} catch (error) {
  report.error = error.stack || error.message;
  throw error;
} finally {
  if (context) { await context.close(); closed = true; }
  await writeFile(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
  await writeFile(path.join(workspace, 'latest-result.json'), JSON.stringify(report, null, 2));
  if (closed || !context) for (const target of [extracted, temporary, profile, downloads]) {
    const resolved = path.resolve(target);
    assert.ok(resolved.startsWith(path.resolve(run) + path.sep) && resolved.startsWith(path.resolve(workspace) + path.sep));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log(`Result: ${path.join(run, 'result.json')}`);
}
