import assert from 'node:assert/strict';
import path from 'node:path';

/** Exercise discovered-video naming through actual popup and preview controls. */
export async function testStreamTitles({ context, worker, mainPage, base, extensionId, tabId, namedDownload, onPageError, screenshotsDirectory }) {
  let popup;
  let preview;
  let secondPage;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function captureCard(locator, filename) {
    if (!screenshotsDirectory) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await locator.screenshot({ path: path.join(screenshotsDirectory, filename) }); }
      catch (error) {
        // Polling can replace a static card while Playwright waits for fonts.
        // Retry only that detached screenshot; functional assertions are not retried.
        if (attempt === 2 || !/not attached|detached/i.test(error.message)) throw error;
        await pause(50);
      }
    }
  }
  const sourceUrl = `${base}/plain.m3u8`;
  async function openPopup(targetPage = mainPage) {
    await popup?.close();
    popup = await context.newPage();
    if (onPageError) popup.on('pageerror', onPageError);
    await targetPage.bringToFront();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    await popup.waitForFunction(() => document.querySelector('#page-host').textContent !== '正在读取当前网页…');
    await popup.locator('#streams-tab').click();
  }
  const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  const getState = targetTabId => send('GET_STATE', { tabId: targetTabId ?? tabId });
  async function waitFor(read, predicate, message) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = await read();
      if (predicate(value)) return value;
      await pause(50);
    }
    throw new Error(message);
  }
  const titleButton = streamId => popup.locator(`button.stream-title-button[data-rename-stream-id="${streamId}"]`);
  const titleInput = streamId => popup.locator(`input.stream-title-input[data-rename-stream-id="${streamId}"]`);
  const sourceCard = streamId => titleButton(streamId).locator('xpath=ancestor::article');
  const pageTitleButton = streamId => popup.locator(`button.stream-use-page-title[data-stream-id="${streamId}"]`);
  const streamState = async (streamId, targetTabId = tabId) => (await getState(targetTabId)).streams.find(stream => stream.id === streamId);
  async function waitCustom(streamId, customTitle, targetTabId = tabId) {
    return waitFor(() => streamState(streamId, targetTabId), stream => stream?.customTitle === customTitle, '发现视频的自定义名称未保存');
  }
  async function rename(streamId, customTitle, via = 'Enter', targetTabId = tabId) {
    await popup.locator('#streams-tab').click();
    await titleButton(streamId).click();
    await titleInput(streamId).fill(customTitle);
    if (via === 'blur') await popup.locator('#streams-tab').click();
    else await titleInput(streamId).press(via);
    await waitCustom(streamId, customTitle, targetTabId);
    await titleButton(streamId).waitFor();
  }
  async function finishNewJob(knownIds, expectedTitle, expectedFilename) {
    const job = await waitFor(async () => (await getState()).jobs.find(item => !knownIds.includes(item.id)), Boolean, '发现视频操作未创建下载任务');
    assert.equal(job.title, expectedTitle, '下载任务必须使用发现卡片的当前名称');
    const finished = await waitFor(async () => (await getState()).jobs.find(item => item.id === job.id), item => {
      if (['error', 'cancelled'].includes(item?.status)) throw new Error(`发现视频下载未完成：${item.error || item.status}`);
      return item?.status === 'complete';
    }, '发现视频下载超时');
    await namedDownload(finished, expectedFilename);
  }
  async function download(streamId, title, expectedFilename = `${title}.mp4`) {
    await popup.locator('#streams-tab').click();
    const known = (await getState()).jobs.map(job => job.id);
    await sourceCard(streamId).getByRole('button', { name: /下载 MP4/ }).click();
    await finishNewJob(known, title, expectedFilename);
  }
  async function expectPageTitleError(streamId) {
    await popup.locator('#notice').evaluate(element => { element.hidden = true; element.textContent = ''; });
    await pageTitleButton(streamId).click();
    await popup.waitForFunction(() => {
      const notice = document.querySelector('#notice');
      return !notice.hidden && notice.classList.contains('is-error') && Boolean(notice.textContent.trim());
    });
    assert.equal((await streamState(streamId)).customTitle, '', '读取标题失败不能静默使用旧标题');
  }
  try {
    await openPopup();
    const stream = await waitFor(async () => (await getState()).streams.find(item => item.url === sourceUrl), Boolean, '找不到发现视频测试卡片');
    const streamId = stream.id;
    assert.equal(await titleInput(streamId).count(), 0);
    await rename(streamId, '发现视频 Enter');
    await rename(streamId, '发现视频失焦', 'blur');
    await titleButton(streamId).click();
    await titleInput(streamId).fill('Esc 放弃的发现名称');
    await titleInput(streamId).press('Escape');
    await titleButton(streamId).waitFor();
    assert.equal((await streamState(streamId)).customTitle, '发现视频失焦');
    assert.equal(await titleButton(streamId).textContent(), '发现视频失焦');
    await captureCard(sourceCard(streamId), 'stream-name-static.png');
    await openPopup();
    assert.equal(await titleButton(streamId).textContent(), '发现视频失焦');
    await mainPage.evaluate(() => fetch('/plain.m3u8', { cache: 'no-store' }).then(response => response.text()));
    assert.equal((await send('RESCAN', { tabId })).ok, true);
    await pause(300);
    assert.equal((await streamState(streamId)).customTitle, '发现视频失焦');
    assert.equal(await titleButton(streamId).textContent(), '发现视频失焦');
    console.log('PASS 发现视频名称：Enter/失焦/Esc，重新打开与资源再次检测保留自定义名称');

    await titleButton(streamId).click();
    await titleInput(streamId).fill('发现草稿直接下载');
    await captureCard(titleInput(streamId).locator('xpath=ancestor::article'), 'stream-name-edit.png');
    const knownDraft = (await getState()).jobs.map(job => job.id);
    await titleInput(streamId).locator('xpath=ancestor::article').getByRole('button', { name: /下载 MP4/ }).click();
    await finishNewJob(knownDraft, '发现草稿直接下载', '发现草稿直接下载.mp4');
    await popup.locator('#streams-tab').click();
    await titleButton(streamId).click();
    await titleInput(streamId).fill('打开预览时的名称');
    const opened = context.waitForEvent('page');
    await titleInput(streamId).locator('xpath=ancestor::article').getByRole('button', { name: '预览', exact: true }).click();
    preview = await opened;
    if (onPageError) preview.on('pageerror', onPageError);
    await preview.waitForURL(/\/preview\.html/);
    await preview.locator('#download').waitFor();
    await preview.waitForFunction(() => document.querySelector('#title').textContent === '打开预览时的名称');
    assert.equal((await streamState(streamId)).customTitle, '打开预览时的名称');
    // A preview snapshot must not freeze the old name used by later downloads.
    await rename(streamId, '预览下载最新名称');
    const knownPreview = (await getState()).jobs.map(job => job.id);
    await preview.locator('#download').click();
    await finishNewJob(knownPreview, '预览下载最新名称', '预览下载最新名称.mp4');
    await preview.close(); preview = undefined;
    console.log('PASS 发现卡片未提交草稿直接下载，以及预览下载，均使用最新自定义文件名');

    await rename(streamId, '');
    assert.match(await titleButton(streamId).textContent(), /未命名/);
    const knownEmpty = (await getState()).jobs.map(job => job.id);
    await sourceCard(streamId).getByRole('button', { name: /下载 MP4/ }).click();
    await titleInput(streamId).waitFor();
    assert.deepEqual((await getState()).jobs.map(job => job.id), knownEmpty, '空名称下载不能静默选择网页标题');
    await titleInput(streamId).press('Escape');
    const openedUnnamed = context.waitForEvent('page');
    await sourceCard(streamId).getByRole('button', { name: '预览', exact: true }).click();
    preview = await openedUnnamed;
    await preview.waitForURL(/\/preview\.html/);
    await preview.locator('#error').evaluate(element => { element.hidden = true; element.textContent = ''; });
    await preview.locator('#download').click();
    await preview.waitForFunction(() => !document.querySelector('#error').hidden && /文件名|填写.*名称/.test(document.querySelector('#error').textContent));
    assert.deepEqual((await getState()).jobs.map(job => job.id), knownEmpty, '无名预览不能静默生成名称并下载');
    await preview.close(); preview = undefined;
    await mainPage.evaluate(() => { document.title = '动态:网页/标题?2026'; });
    await pageTitleButton(streamId).click();
    const selected = await waitFor(() => streamState(streamId), item => Boolean(item?.customTitle), '使用当前网页标题未更新名称');
    assert.match(selected.customTitle, /动态/);
    assert.notEqual(selected.customTitle, '流光自动检测测试', '必须读取即时document.title，不能使用旧缓存');
    await captureCard(sourceCard(streamId), 'stream-page-title.png');
    await download(streamId, selected.customTitle, '动态_网页_标题_2026.mp4');
    await rename(streamId, '');
    await mainPage.evaluate(() => { document.title = ''; });
    await expectPageTitleError(streamId);
    await mainPage.evaluate(() => { document.title = '不应在脚本失败时回退到这个标题'; });
    await worker.evaluate(() => {
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      globalThis.restoreStreamTitleScript = () => { chrome.scripting.executeScript = original; };
      chrome.scripting.executeScript = () => Promise.reject(new Error('E2E page script access denied'));
    });
    try { await expectPageTitleError(streamId); }
    finally { await worker.evaluate(() => globalThis.restoreStreamTitleScript?.()); }
    console.log('PASS 空名称明确提示；当前网页标题实时读取且安全命名；空标题/脚本拒绝均报错不静默回退');

    await mainPage.evaluate(() => { document.title = '流光自动检测测试'; });
    await rename(streamId, '第一页独立名称');
    secondPage = await context.newPage();
    await secondPage.goto(base);
    const secondTabId = await worker.evaluate(async ({ firstTabId, expectedUrl }) => (await chrome.tabs.query({})).find(tab => tab.id !== firstTabId && tab.url === expectedUrl)?.id, { firstTabId: tabId, expectedUrl: `${base}/` });
    assert.ok(Number.isInteger(secondTabId));
    const secondStream = await waitFor(async () => (await getState(secondTabId)).streams.find(item => item.url === sourceUrl), Boolean, '第二个标签页未检测同一视频');
    assert.notEqual(secondStream.id, streamId);
    assert.equal(Object.hasOwn(secondStream, 'customTitle'), false, '新标签页检测不能继承任何旧自定义名称');
    await openPopup(secondPage);
    await rename(secondStream.id, '第二页独立名称', 'Enter', secondTabId);
    assert.equal((await streamState(streamId)).customTitle, '第一页独立名称');
    await openPopup();
    const openedSnapshot = context.waitForEvent('page');
    await sourceCard(streamId).getByRole('button', { name: '预览', exact: true }).click();
    preview = await openedSnapshot;
    await preview.waitForURL(/\/preview\.html/);
    await popup.locator('#clear-streams').click();
    await waitFor(async () => (await getState()).streams, streams => streams.length === 0, '清空发现列表后仍有视频源');
    const knownSnapshot = (await getState()).jobs.map(job => job.id);
    await preview.locator('#download').click();
    await finishNewJob(knownSnapshot, '第一页独立名称', '第一页独立名称.mp4');
    assert.equal((await getState()).streams.length, 0, '清空后的预览下载不能复活发现卡片');
    await preview.close(); preview = undefined;
    await mainPage.evaluate(() => fetch('/plain.m3u8', { cache: 'no-store' }).then(response => response.text()));
    const rediscovered = await waitFor(async () => (await getState()).streams.find(item => item.url === sourceUrl), Boolean, '清空后未重新检测到测试视频');
    assert.notEqual(rediscovered.id, streamId);
    assert.equal(Object.hasOwn(rediscovered, 'customTitle'), false, '清空后不能恢复任何旧自定义名称');
    assert.equal((await streamState(secondStream.id, secondTabId)).customTitle, '第二页独立名称', '同URL的另一标签页名称不能被清空或覆盖');
    console.log('PASS 清空发现记录不会复活旧名称；相同URL在不同标签页独立命名');
  } finally {
    await preview?.close();
    await popup?.close();
    await secondPage?.close();
  }
}
