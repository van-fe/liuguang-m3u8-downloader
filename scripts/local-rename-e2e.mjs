import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat, open, rename, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeDownloads, useNativeDownloads, loadExtension } from './e2e-downloads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('playwright');
const results = path.join(root, 'test-results', 'local-rename');
const runDirectory = path.join(results, String(Date.now()));
const output = path.join(runDirectory, 'downloads');
const fixtures = path.join(runDirectory, 'fixtures');
const profile = path.join(root, `.local-rename-e2e-${Date.now()}`);
await mkdir(fixtures, { recursive: true });
await prepareNativeDownloads(profile, output);
const preferencesFile = path.join(profile, 'Default', 'Preferences');
const preferences = JSON.parse(await readFile(preferencesFile, 'utf8'));
// This is an isolated test profile. Real file handles and native move() are
// exercised, while native permission prompts and the directory picker are not.
preferences.profile = { default_content_setting_values: { file_system_write_guard: 1, file_system_read_guard: 1 } };
await writeFile(preferencesFile, JSON.stringify(preferences));
const generation = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart',
  path.join(fixtures, 'video.mp4')], { encoding: 'utf8', windowsHide: true });
assert.equal(generation.status, 0, generation.stderr);
const mp4 = await readFile(path.join(fixtures, 'video.mp4'));
const originalHash = createHash('sha256').update(mp4).digest('hex');
const server = createServer((request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (new URL(request.url, 'http://localhost').pathname === '/video.mp4') {
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length });
    response.end(mp4);
  } else {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>本机文件改名测试</title><h1>Local rename fixture</h1>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const summary = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, predicate, description) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await pause(50);
  }
  throw new Error(description);
}
const exists = filename => stat(filename).then(() => true, () => false);
async function assertFile(filename, expectedHash = originalHash) {
  assert.equal(createHash('sha256').update(await readFile(filename)).digest('hex'), expectedHash);
}
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ignoreDefaultArgs: ['--disable-extensions'], headless: true,
    args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true, downloadsPath: output,
    viewport: { width: 960, height: 760 }
  });
  const browserCDP = await context.browser().newBrowserCDPSession();
  await useNativeDownloads(browserCDP);
  const version = await browserCDP.send('Browser.getVersion');
  const { id, worker } = await loadExtension(context, browserCDP, path.join(root, 'dist', 'liuguang-m3u8'));
  const main = await context.newPage();
  await main.goto(base);
  let popup;
  async function openPopup() {
    await popup?.close();
    popup = await context.newPage();
    await main.bringToFront();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(() => document.querySelector('#page-host').textContent !== '正在读取当前网页…');
    await popup.locator('#jobs-tab').click();
  }
  await openPopup();
  const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  const getState = () => send('GET_STATE');
  const jobState = async jobId => (await getState()).jobs.find(job => job.id === jobId);
  const titleButton = jobId => popup.locator(`button.job-title-button[data-rename-job-id="${jobId}"]`);
  const titleInput = jobId => popup.locator(`input.job-title-input[data-rename-job-id="${jobId}"]`);
  async function beginRename(jobId, title) {
    await popup.locator('#notice').evaluate(element => { element.hidden = true; element.textContent = ''; });
    await popup.locator('#jobs-tab').click();
    await titleButton(jobId).click();
    await titleInput(jobId).fill(title);
    await titleInput(jobId).press('Enter');
  }
  async function completeDownload(query) {
    const started = await send('START_DOWNLOAD', { url: `${base}/video.mp4?${query}`, title: '同名原始视频', saveAs: false });
    assert.equal(started.ok, true, started.error);
    const job = await waitFor(() => jobState(started.jobId), value => {
      if (['error', 'cancelled'].includes(value?.status)) throw new Error(value.error || value.status);
      return value?.status === 'complete';
    }, 'Native MP4 fixture did not complete');
    const item = await worker.evaluate(async downloadId => (await chrome.downloads.search({ id: downloadId }))[0], job.downloadId);
    assert.equal(item.state, 'complete');
    await assertFile(item.filename);
    return { job, item };
  }
  const first = await completeDownload('first');
  const duplicate = await completeDownload('second');
  assert.equal(path.basename(first.item.filename), '同名原始视频.mp4');
  assert.equal(path.basename(duplicate.item.filename), '同名原始视频 (1).mp4');
  summary.push({ name: 'actual-native-downloads', filenames: [path.basename(first.item.filename), path.basename(duplicate.item.filename)], sha256: originalHash });
  console.log('PASS 真实 MP4 下载与 Chrome 重名序号，完成任务持有实际下载路径');

  const pagesBeforeAuthorization = context.pages().length;
  await beginRename(duplicate.job.id, '重命名中文 2026');
  const authorization = popup;
  const authorizeButton = authorization.locator('button[data-authorize-job-id="' + duplicate.job.id + '"]');
  await authorizeButton.waitFor();
  assert.equal(context.pages().length, pagesBeforeAuthorization, 'First-time authorization must remain inside the plugin popup.');
  const ticketId = await authorization.evaluate(async jobId => {
    const saved = await chrome.storage.session.get('localRenameRequests');
    return Object.entries(saved.localRenameRequests || {}).find(([, entry]) => entry.jobId === jobId)?.[0];
  }, duplicate.job.id);
  const details = await authorization.evaluate(id => chrome.runtime.sendMessage({ target: 'background', type: 'GET_LOCAL_RENAME', id }), ticketId);
  assert.equal(details.ok, true, details.error);
  assert.equal(details.currentFilename, '同名原始视频 (1).mp4');
  assert.equal(path.normalize(details.currentPath), path.normalize(duplicate.item.filename));
  assert.equal(details.filename, '重命名中文 2026.mp4');
  assert.equal((await jobState(duplicate.job.id)).title, duplicate.job.title, 'Opening authorization must not pretend to rename the file.');
  await assertFile(duplicate.item.filename);
  await authorization.screenshot({ path: path.join(results, 'authorization.png') });
  await authorization.evaluate(() => { window.showDirectoryPicker = async () => { throw new DOMException('Test user cancelled directory picker', 'AbortError'); }; });
  await authorizeButton.click();
  await waitFor(() => authorizeButton.isEnabled(), Boolean, 'Picker cancellation left authorization disabled');
  assert.equal((await jobState(duplicate.job.id)).title, duplicate.job.title);
  await assertFile(duplicate.item.filename);
  await authorization.evaluate(() => { window.showDirectoryPicker = async () => { throw new DOMException('Test permission denied', 'NotAllowedError'); }; });
  await authorizeButton.click();
  await waitFor(() => authorizeButton.isEnabled(), Boolean, 'Permission refusal left authorization disabled');
  assert.equal((await jobState(duplicate.job.id)).title, duplicate.job.title);
  await assertFile(duplicate.item.filename);
  console.log('PASS 首次改名在插件卡片内显示目标名称及实际文件夹；取消选择/权限拒绝不改变原文件或任务且不打开新页');

  async function directoryHandle(page, directory) {
    await page.evaluate(() => {
      globalThis.localRenameTestDirectory = undefined;
      globalThis.localRenameDropError = undefined;
      let drop = document.getElementById('local-rename-e2e-drop');
      if (!drop) {
        drop = document.createElement('div'); drop.id = 'local-rename-e2e-drop';
        drop.style.cssText = 'position:fixed;right:0;bottom:0;width:50px;height:50px;z-index:99999;background:#ddd';
        drop.textContent = 'Test'; document.body.append(drop);
        drop.addEventListener('dragover', event => event.preventDefault());
        drop.addEventListener('drop', event => {
          event.preventDefault();
          event.dataTransfer.items[0].getAsFileSystemHandle().then(handle => { globalThis.localRenameTestDirectory = handle; }, error => { globalThis.localRenameDropError = error.name; });
        });
      }
    });
    const bounds = await page.locator('#local-rename-e2e-drop').boundingBox();
    const cdp = await context.newCDPSession(page);
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await cdp.send('Input.dispatchDragEvent', { type, x: bounds.x + 25, y: bounds.y + 25,
        data: { items: [], files: [directory], dragOperationsMask: 1 } });
    }
    await page.waitForFunction(() => globalThis.localRenameTestDirectory || globalThis.localRenameDropError);
    assert.equal(await page.evaluate(() => globalThis.localRenameDropError), undefined);
    await cdp.detach();
  }
  await directoryHandle(authorization, output);
  await authorization.evaluate(() => { window.showDirectoryPicker = async () => globalThis.localRenameTestDirectory; });
  await authorizeButton.click();
  const renamed = await waitFor(() => jobState(duplicate.job.id), job => job?.title === '重命名中文 2026', 'Directory authorization did not rename the downloaded file');
  const firstRenamedPath = path.join(output, '重命名中文 2026.mp4');
  assert.equal(path.normalize(renamed.localFilePath), path.normalize(firstRenamedPath));
  assert.equal(await exists(duplicate.item.filename), false);
  await assertFile(firstRenamedPath);
  await assertFile(first.item.filename);
  await authorization.waitForFunction(() => !document.querySelector('#notice').hidden && document.querySelector('#notice').textContent.includes('磁盘中的文件和任务名称均已修改'));
  assert.equal(context.pages().length, pagesBeforeAuthorization, 'Successful authorization must not create an external setup page.');
  await authorization.screenshot({ path: path.join(results, 'renamed.png') });
  summary.push({ name: 'inline-popup-authorized-rename', noNewTab: true, originalFilename: path.basename(duplicate.item.filename), filename: path.basename(firstRenamedPath), originalRemoved: true, contentUnchanged: true });
  console.log('PASS 授权真实目录句柄后原地重命名含序号的文件，旧路径消失、新文件 SHA-256 完全一致');

  const pageCount = context.pages().length;
  await openPopup();
  await titleButton(duplicate.job.id).waitFor();
  await beginRename(duplicate.job.id, '第二次直接改名');
  const secondRenamed = await waitFor(() => jobState(duplicate.job.id), job => job?.title === '第二次直接改名', 'Saved directory did not allow direct inline rename');
  const secondRenamedPath = path.join(output, '第二次直接改名.mp4');
  assert.equal(path.normalize(secondRenamed.localFilePath), path.normalize(secondRenamedPath));
  assert.equal(context.pages().length, pageCount, 'Existing authorization should not open another setup tab.');
  assert.equal(await exists(firstRenamedPath), false);
  await assertFile(secondRenamedPath);
  await popup.screenshot({ path: path.join(results, 'inline-renamed.png') });
  console.log('PASS 关闭重开插件后，已存目录授权直接用于卡片第二次改名，无需重新选择目录');

  const lifecycle = await context.newCDPSession(popup);
  const versions = new Map();
  lifecycle.on('ServiceWorker.workerVersionUpdated', ({ versions: updates }) => {
    for (const version of updates) versions.set(version.versionId, version);
  });
  await lifecycle.send('ServiceWorker.enable');
  const originalVersion = await waitFor(() => [...versions.values()].find(version => version.scriptURL === `chrome-extension://${id}/background.js`),
    Boolean, 'The extension worker must be observable before the suspension test.');
  await lifecycle.send('ServiceWorker.stopWorker', { versionId: originalVersion.versionId });
  await waitFor(() => versions.get(originalVersion.versionId), version => version?.runningStatus === 'stopped', 'Extension worker did not stop.');
  await getState();
  await waitFor(() => versions.get(originalVersion.versionId), version => version?.runningStatus === 'running', 'Extension worker did not restart after suspension.');
  await lifecycle.detach();
  await beginRename(duplicate.job.id, '后台重启后改名');
  const restartedRename = await waitFor(() => jobState(duplicate.job.id), job => job?.title === '后台重启后改名', 'Stored authorization failed after service worker restart.');
  const currentPath = path.join(output, '后台重启后改名.mp4');
  assert.equal(path.normalize(restartedRename.localFilePath), path.normalize(currentPath));
  assert.equal(await exists(secondRenamedPath), false);
  await assertFile(currentPath);
  summary.push({ name: 'service-worker-restart', directoryHandlePersisted: true, actualRenameCompleted: true });
  console.log('PASS 后台工作线程被停止并重新唤醒后，持久目录句柄仍能实际重命名文件');

  const conflictPath = path.join(output, '已经存在.mp4');
  const conflictBytes = Buffer.from('unrelated local fixture, must never be overwritten');
  await writeFile(conflictPath, conflictBytes);
  await beginRename(duplicate.job.id, '已经存在');
  await popup.waitForFunction(() => !document.querySelector('#notice').hidden && document.querySelector('#notice').classList.contains('is-error'));
  assert.equal((await jobState(duplicate.job.id)).title, '后台重启后改名');
  await assertFile(currentPath);
  assert.deepEqual(await readFile(conflictPath), conflictBytes);
  await titleInput(duplicate.job.id).press('Escape');
  console.log('PASS 目标同名文件冲突明确拒绝，既有目标、原视频与任务名称均保留');

  const movedOutside = path.join(fixtures, 'externally-moved.mp4');
  await rename(currentPath, movedOutside);
  await beginRename(duplicate.job.id, '源文件不在原位置');
  await popup.waitForFunction(() => !document.querySelector('#notice').hidden && document.querySelector('#notice').classList.contains('is-error'));
  assert.equal((await jobState(duplicate.job.id)).title, '后台重启后改名');
  await assertFile(movedOutside);
  assert.equal(await exists(path.join(output, '源文件不在原位置.mp4')), false);
  await titleInput(duplicate.job.id).press('Escape');
  await rename(movedOutside, currentPath);
  console.log('PASS 源文件在外部移动后改名失败，不假报成功、不更改任务名称');

  // Test native metadata rename beyond 32-bit offsets without downloading or
  // duplicating multiple gigabytes. The file contains only two sentinels.
  const largeDirectory = path.join(runDirectory, 'large');
  await mkdir(largeDirectory, { recursive: true });
  const largePath = path.join(largeDirectory, 'sparse-large.mp4');
  const largeSize = 4 * 1024 ** 3 + 4096;
  const largeFile = await open(largePath, 'w');
  try {
    if (process.platform === 'win32') {
      const sparse = spawnSync('fsutil', ['sparse', 'setflag', largePath], { encoding: 'utf8', windowsHide: true });
      assert.equal(sparse.status, 0, sparse.stderr || sparse.stdout);
    }
    await largeFile.truncate(largeSize);
    await largeFile.write(Buffer.from('LOCAL-RENAME-HEAD'), 0, 17, 0);
    await largeFile.write(Buffer.from('LOCAL-RENAME-TAIL'), 0, 17, largeSize - 17);
  } finally { await largeFile.close(); }
  const largeBefore = await stat(largePath, { bigint: true });
  await directoryHandle(popup, largeDirectory);
  const largeResult = await popup.evaluate(async ({ directoryPath, filename, size }) => {
    const module = await import('./lib/local-downloads.js');
    await module.saveDirectory(directoryPath, globalThis.localRenameTestDirectory);
    const start = performance.now();
    const result = await module.renameLocalDownload({ status: 'complete', localFilePath: filename, localFileSize: size }, '大视频原地改名');
    return { result, elapsedMs: performance.now() - start };
  }, { directoryPath: largeDirectory, filename: largePath, size: largeSize });
  const largeRenamedPath = path.join(largeDirectory, '大视频原地改名.mp4');
  assert.equal(await exists(largePath), false);
  const largeAfter = await stat(largeRenamedPath, { bigint: true });
  assert.equal(largeAfter.size, BigInt(largeSize));
  if (largeBefore.ino !== 0n) assert.equal(largeAfter.ino, largeBefore.ino, 'Native rename must preserve filesystem file identity.');
  const largeRead = await open(largeRenamedPath, 'r');
  try {
    const head = Buffer.alloc(17), tail = Buffer.alloc(17);
    await largeRead.read(head, 0, head.length, 0);
    await largeRead.read(tail, 0, tail.length, largeSize - tail.length);
    assert.equal(head.toString(), 'LOCAL-RENAME-HEAD');
    assert.equal(tail.toString(), 'LOCAL-RENAME-TAIL');
  } finally { await largeRead.close(); }
  assert.ok(largeRenamedPath.startsWith(runDirectory + path.sep));
  await unlink(largeRenamedPath);
  summary.push({ name: 'native-large-file-rename', size: largeSize, elapsedMs: Math.round(largeResult.elapsedMs), fileIdentityPreserved: true, sentinelsPreserved: true, sparseFixtureRemoved: true });
  console.log(`PASS 超过 4 GiB 稀疏测试文件原地改名：大小/文件标识/首尾数据均保持（${Math.round(largeResult.elapsedMs)} ms）`);

  const reports = await send('GET_DIAGNOSTICS');
  const diagnosticText = JSON.stringify(reports);
  assert.doesNotMatch(diagnosticText, /同名原始视频|重命名中文|第二次直接改名|downloads|sparse-large|127\.0\.0\.1/);
  const report = { testedAt: new Date().toISOString(), browser: version.product,
    permissionTestScope: 'A dedicated test profile pregrants filesystem read/write permission. Directory picking is substituted in the test with a real directory handle obtained by CDP drag/drop. Native permission dialog interaction is not verified.',
    downloadPolicy: 'default', tests: summary };
  await writeFile(path.join(results, 'result.json'), JSON.stringify(report, null, 2));
  console.log(`E2E 本地文件改名全部通过，报告：${path.join(results, 'result.json')}`);
} finally {
  await context?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
