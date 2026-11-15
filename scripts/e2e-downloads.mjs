import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Keep Chrome's native download naming path enabled. Playwright's allowAndName
// forces GUIDs, while allow bypasses extension filename arbitration.
export async function prepareNativeDownloads(profilePath, downloadPath) {
  await mkdir(path.join(profilePath, 'Default'), { recursive: true });
  await mkdir(downloadPath, { recursive: true });
  await writeFile(path.join(profilePath, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: downloadPath, prompt_for_download: false, directory_upgrade: true },
    savefile: { default_directory: downloadPath }
  }));
}

export async function useNativeDownloads(cdp) {
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true });
}

export async function createPassiveFilenameExtension(output) {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Local passive filename regression fixture', version: '1.0.0',
    permissions: ['downloads'], background: { service_worker: 'background.js' }
  }));
  await writeFile(path.join(output, 'background.js'), `
globalThis.filenameEvents = 0;
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  globalThis.filenameEvents++;
  let blobOwner;
  try { blobOwner = new URL(item.url.slice(5)).hostname; } catch {}
  globalThis.lastFilenameEvent = {
    id: item.id, byExtensionId: item.byExtensionId, blobOwner,
    hasByExtensionId: typeof item.byExtensionId === 'string',
    hasExtensionId: typeof item.extensionId === 'string', extensionId: item.extensionId,
    filenameIsUuid: /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/i.test(item.filename)
  };
  // Stay fully passive for all main-extension downloads. The final scope test
  // enables an explicit name only for this fixture's own independent download.
  if (globalThis.foreignName && item.byExtensionId === chrome.runtime.id) {
    suggest({ filename: globalThis.foreignName, conflictAction: 'uniquify' });
  } else suggest();
});
`);
  await writeFile(path.join(output, 'download.html'), '<!doctype html><meta charset="utf-8"><title>Local foreign download fixture</title>');
  return output;
}

export async function loadExtension(context, cdp, extensionPath) {
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  const matches = worker => worker.url() === `chrome-extension://${id}/background.js`;
  const worker = context.serviceWorkers().find(matches) || await context.waitForEvent('serviceworker', { predicate: matches });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await worker.evaluate(() => Boolean(globalThis.chrome?.downloads?.search)).catch(() => false)) break;
    assert.notEqual(attempt, 99, 'Extension downloads API must initialize.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return { id, worker };
}

export async function observeExtensionConsole(cdp, extensionId, onEntry) {
  const target = (await cdp.send('Target.getTargets')).targetInfos
    .find(item => item.url === `chrome-extension://${extensionId}/background.js`);
  assert.ok(target);
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  const receive = event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message);
    if (message.method === 'Runtime.consoleAPICalled') {
      onEntry({ type: message.params.type, message: message.params.args.map(arg => arg.value || arg.description || '').join(' ') });
    } else if (message.method === 'Log.entryAdded') {
      onEntry({ type: message.params.entry.level, message: message.params.entry.text });
    } else if (message.method === 'Runtime.exceptionThrown') {
      onEntry({ type: 'exception', message: message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text });
    }
  };
  cdp.on('Target.receivedMessageFromTarget', receive);
  for (const [id, method] of [[1, 'Runtime.enable'], [2, 'Log.enable']]) {
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method }) });
  }
  return async () => {
    cdp.off('Target.receivedMessageFromTarget', receive);
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  };
}

// Evaluate a test hook in an existing offscreen document without navigating or
// replacing it. Keep CDP's userGesture false so background behavior stays real.
export async function evaluateExtensionDocument(cdp, extensionId, filename, expression) {
  const target = (await cdp.send('Target.getTargets')).targetInfos
    .find(item => item.url === `chrome-extension://${extensionId}/${filename}`);
  assert.ok(target, 'The existing extension document must be available.');
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
  const response = new Promise((resolve, reject) => {
    const listener = event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message);
      if (message.id !== 1) return;
      cdp.off('Target.receivedMessageFromTarget', listener);
      if (message.error || message.result?.exceptionDetails) reject(new Error('Extension test hook evaluation failed.'));
      else resolve(message.result.result?.value);
    };
    cdp.on('Target.receivedMessageFromTarget', listener);
  });
  try {
    await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, userGesture: false }
    }) });
    return await response;
  } finally { await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}); }
}

export async function assertForeignFilename(context, cdp, extensionPath, loaded) {
  const { id, worker } = loaded || await loadExtension(context, cdp, extensionPath);
  assert.equal(await worker.evaluate(() => chrome.downloads.onDeterminingFilename.hasListeners()), true);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/download.html`);
  const expected = '其他扩展自己的文件.txt';
  await worker.evaluate(filename => { globalThis.foreignName = filename; }, expected);
  const downloadId = await page.evaluate(async filename => {
    globalThis.foreignBlob = URL.createObjectURL(new Blob(['foreign extension fixture'], { type: 'text/plain' }));
    return chrome.downloads.download({ url: globalThis.foreignBlob, filename, saveAs: false });
  }, expected);
  let item;
  for (let attempt = 0; attempt < 100; attempt++) {
    item = await worker.evaluate(async id => (await chrome.downloads.search({ id }))[0], downloadId);
    if (item?.state === 'complete') break;
    assert.notEqual(item?.state, 'interrupted', 'Foreign extension download must complete.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(item?.state, 'complete');
  assert.equal(path.basename(item.filename), expected, 'Our filename listener must not rename another extension download.');
  await page.evaluate(() => URL.revokeObjectURL(globalThis.foreignBlob));
  await page.close();
  return { id, worker };
}
