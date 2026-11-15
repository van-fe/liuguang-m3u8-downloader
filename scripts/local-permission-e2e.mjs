import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareNativeDownloads, useNativeDownloads, loadExtension } from './e2e-downloads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('playwright');
const results = path.join(root, 'test-results', 'local-permission');
const firstGesture = process.argv.find(value => value.startsWith('--gesture='))?.slice('--gesture='.length);
if (!firstGesture) {
  await mkdir(results, {recursive:true});
  const cases = [];
  for (const gesture of ['Enter', 'blur', 'inline']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--gesture=' + gesture], {encoding:'utf8',windowsHide:true});
    process.stdout.write(child.stdout || '');
    process.stderr.write(child.stderr || '');
    assert.equal(child.status, 0, 'Fresh-profile permission case failed: ' + gesture);
    cases.push(JSON.parse(await readFile(path.join(results, 'result-' + gesture + '.json'), 'utf8')));
  }
  await writeFile(path.join(results, 'result.json'), JSON.stringify({testedAt:new Date().toISOString(),browser:cases[0].browser,filesystemGuardPregrant:false,
    scope:'Each Enter/blur expiry case and the first inline authorization case run in a fresh Chrome profile with normal content settings and real action popups. Native directory picking is represented by CDP drag/drop of an actual directory; denial and no-activation UI failures are explicitly simulated.',cases},null,2));
  console.log('All fresh-profile permission lifecycle and inline authorization cases passed: ' + path.join(results,'result.json'));
  process.exit(0);
}
assert.ok(['Enter','blur','inline'].includes(firstGesture));
const runDirectory = path.join(results, String(Date.now()) + '-' + firstGesture);
const output = path.join(runDirectory, 'downloads');
const fixture = path.join(runDirectory, 'fixture.mp4');
const profile = path.join(root, `.local-permission-e2e-${Date.now()}`);
await mkdir(runDirectory, { recursive: true });
await prepareNativeDownloads(profile, output);
// Keep ordinary Chrome content settings. No filesystem guard pregrant is used.
const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
  'testsrc2=size=160x90:rate=12', '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', fixture], { encoding: 'utf8', windowsHide: true });
assert.equal(generated.status, 0, generated.stderr);
const bytes = await readFile(fixture);
const expectedHash = createHash('sha256').update(bytes).digest('hex');
const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }).end(bytes));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/video.mp4`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(read, predicate, description, attempts = 150) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const value = await read();
    if (predicate(value)) return value;
    await pause(50);
  }
  throw new Error(description);
}
const hash = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');
let context;
const summary = [];
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ignoreDefaultArgs: ['--disable-extensions'], headless: true,
    args: ['--enable-unsafe-extension-debugging'], acceptDownloads: true, downloadsPath: output,
    viewport: { width: 440, height: 720 }
  });
  const browser = await context.browser().newBrowserCDPSession();
  await useNativeDownloads(browser);
  const version = await browser.send('Browser.getVersion');
  const { id, worker } = await loadExtension(context, browser, path.join(root, 'dist', 'liuguang-m3u8'));
  let sequence = 0;
  async function actionPopup() {
    await worker.evaluate(() => chrome.action.openPopup());
    const target = await waitFor(async () => (await browser.send('Target.getTargets')).targetInfos.find(target => target.url === `chrome-extension://${id}/popup.html`), Boolean, 'The real Chrome action popup must open');
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: false });
    const pending = new Map();
    const receive = event => {
      if (event.sessionId !== sessionId) return;
      const message = JSON.parse(event.message), waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      message.error ? waiter.reject(message.error) : waiter.resolve(message.result);
    };
    browser.on('Target.receivedMessageFromTarget', receive);
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++sequence;
      pending.set(key, { resolve, reject });
      browser.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id: key, method, params }) }).catch(reject);
    });
    const evaluate = async expression => {
      const value = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: false });
      if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
      return value.result?.value;
    };
    const click = async selector => {
      const bounds = await evaluate(`(()=>{const item=document.querySelector(${JSON.stringify(selector)});if(!item)throw new Error('Missing control');item.scrollIntoView({block:'center'});const r=item.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', ...bounds, button: 'left', clickCount: 1 });
      await call('Input.dispatchMouseEvent', { type: 'mouseReleased', ...bounds, button: 'left', clickCount: 1 });
    };
    const send = (type, data = {}) => evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ target: 'background', type, ...data })})`);
    const close = async () => { browser.off('Target.receivedMessageFromTarget', receive); await browser.send('Target.closeTarget', { targetId: target.targetId }); };
    await waitFor(() => evaluate("Boolean(document.querySelector('#jobs-tab'))"), Boolean, 'Popup DOM did not initialize');
    return { targetId: target.targetId, call, evaluate, click, send, close };
  }
  const setup = await context.newPage();
  await setup.goto(`chrome-extension://${id}/popup.html`);
  const setupSend = (type, data = {}) => setup.evaluate(message => chrome.runtime.sendMessage(message), { target: 'background', type, ...data });
  const started = await setupSend('START_DOWNLOAD', { url, title: '授权复用原始视频', saveAs: false });
  assert.equal(started.ok, true, started.error);
  const job = await waitFor(() => setupSend('GET_STATE').then(state => state.jobs.find(job => job.id === started.jobId)), item => { if (item?.status === 'error') throw new Error(item.error); return item?.status === 'complete'; }, 'Native video fixture download did not finish', 300);
  const originalPath = await worker.evaluate(async downloadId => (await chrome.downloads.search({ id: downloadId }))[0].filename, job.downloadId);
  assert.equal(await hash(originalPath), expectedHash);
  await setup.close();
  let popup = await actionPopup();
  const currentJob = () => popup.send('GET_STATE').then(state => state.jobs.find(job => job.id === started.jobId));
  // CDP delivers an actual directory drag into the real extension action popup.
  // This grants read access, while ordinary write permission is initially prompt.
  await popup.evaluate(`(()=>{const drop=document.createElement('div');drop.id='permission-test-drop';drop.style.cssText='position:fixed;top:180px;left:30px;width:200px;height:100px;background:#eee;z-index:999999';drop.textContent='Test directory';drop.addEventListener('dragover',e=>e.preventDefault());drop.addEventListener('drop',event=>{event.preventDefault();event.dataTransfer.items[0].getAsFileSystemHandle().then(handle=>globalThis.testDirectory=handle).catch(error=>globalThis.dropError=error.name)});document.body.append(drop);return true;})()`);
  for (const type of ['dragEnter', 'dragOver', 'drop']) await popup.call('Input.dispatchDragEvent', { type, x: 80, y: 220, data: { items: [], files: [output], dragOperationsMask: 1 } });
  await waitFor(() => popup.evaluate('Boolean(globalThis.testDirectory||globalThis.dropError)'), Boolean, 'The normal profile did not receive the directory handle');
  const initial = await popup.evaluate("(async()=>({read:await testDirectory.queryPermission({mode:'read'}),write:await testDirectory.queryPermission({mode:'readwrite'})}))()");
  assert.equal(initial.read, 'granted');
  assert.equal(initial.write, 'prompt');
  const titleSelector = `button.job-title-button[data-rename-job-id="${job.id}"]`;
  const chooseSelector = `button[data-authorize-job-id="${job.id}"]`;
  let authorized;
  if(firstGesture === 'inline') {
  await popup.evaluate("(()=>{document.querySelector('#permission-test-drop').remove();window.showDirectoryPicker=async()=>globalThis.testDirectory;return true;})()");
  await popup.click('#jobs-tab');
  await waitFor(() => popup.evaluate('Boolean(document.querySelector(' + JSON.stringify(titleSelector) + '))'), Boolean, 'Completed title did not appear in the real popup.');
  await popup.click(titleSelector);
  await popup.call('Input.insertText',{text:'首次弹窗内授权'});
  await popup.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await popup.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await waitFor(() => popup.evaluate('Boolean(document.querySelector(' + JSON.stringify(chooseSelector) + '))'), Boolean, 'First authorization must stay in the real popup card.');
  assert.equal((await currentJob()).title,job.title,'A pending folder choice must not change the task title.');
  const authorizationScreenshot=await popup.call('Page.captureScreenshot',{format:'png'});
  await writeFile(path.join(results,'inline-authorization.png'),Buffer.from(authorizationScreenshot.data,'base64'));
  await popup.click(chooseSelector);
  authorized=await waitFor(currentJob, value=>value?.title==='首次弹窗内授权','The popup picker button must acquire ordinary directory permission and rename the file.');
  assert.equal(await hash(authorized.localFilePath),expectedHash);
  assert.equal(await stat(originalPath).then(()=>true,()=>false),false);
  assert.equal((await browser.send('Target.getTargets')).targetInfos.some(target=>target.url.startsWith(`chrome-extension://${id}/local-rename.html?`)),false);
  const firstGrant=await popup.evaluate(`(async()=>{const module=await import('./lib/local-downloads.js');return(await module.getSavedDirectory(${JSON.stringify(output)})).queryPermission({mode:'readwrite'});})()`);
  assert.equal(firstGrant,'granted');
  summary.push({name:'first-directory-authorization-in-real-popup',before:initial.write,after:firstGrant,noNewPage:true,nativeRenameCompleted:true,contentUnchanged:true});
  } else {
    // Establish a saved grant without a file move; this isolates Chrome's
    // temporary-grant expiry from its later native-operation permission renewal.
    await popup.evaluate(`(()=>{document.querySelector('#permission-test-drop').remove();const button=document.createElement('button');button.id='permission-test-initial';button.style.cssText='position:fixed;left:30px;top:290px;z-index:999999';button.textContent='Grant fixture directory';button.onclick=async()=>{try{globalThis.initialPermission={status:'pending'};const permission=await testDirectory.requestPermission({mode:'readwrite'});if(permission==='granted'){const module=await import('./lib/local-downloads.js');await module.saveDirectory(${JSON.stringify(output)},testDirectory);}globalThis.initialPermission={status:'done',permission};}catch(error){globalThis.initialPermission={status:'error',error:error.name+': '+error.message}}};document.body.append(button);return true;})()`);
    await popup.click('#permission-test-initial');
    const granted=await waitFor(()=>popup.evaluate('globalThis.initialPermission'),value=>value?.status!=='pending','Fixture grant was not established');
    assert.equal(granted.permission,'granted',JSON.stringify(granted));
    authorized={localFilePath:originalPath};
  }
  await popup.close();
  console.log(firstGesture==='inline'?'PASS 普通 Chrome 设置下，首次选择目录和真实原地改名均在 action popup 卡片中完成，无单独授权页或文件系统预授权':'PASS 普通 Chrome 设置下建立真实已存目录句柄，无文件系统全局预授权');

  let previousPath = authorized.localFilePath;
  for (const [index, via] of (firstGesture === 'inline' ? [] : firstGesture === 'Enter' ? ['Enter', 'blur'] : ['blur', 'Enter']).entries()) {
    // Closing every visible extension document causes Chrome to revoke the
    // active grant. The offscreen download engine remains, as in normal use.
    await pause(6500);
    popup = await actionPopup();
    const stored = await popup.evaluate(`(async()=>{const module=await import('./lib/local-downloads.js');const handle=await module.getSavedDirectory(${JSON.stringify(output)});return{hasStoredHandle:Boolean(handle),read:await handle.queryPermission({mode:'read'}),write:await handle.queryPermission({mode:'readwrite'})};})()`);
    assert.equal(stored.hasStoredHandle, true);
    if(index === 0) assert.equal(stored.write, 'prompt', 'The regression must exercise an expired active grant, not a global pregrant.');
    else assert.ok(['prompt','granted'].includes(stored.write));
    await popup.click('#jobs-tab');
    await waitFor(() => popup.evaluate(`Boolean(document.querySelector(${JSON.stringify(titleSelector)}))`), Boolean, 'Completed video title is missing');
    await popup.click(titleSelector);
    await popup.call('Input.insertText', { text: `真实弹窗${via}恢复权限 ${index + 1}` });
    if (via === 'Enter') {
      await popup.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await popup.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    } else await popup.click('#jobs-tab');
    const desiredTitle = `真实弹窗${via}恢复权限 ${index + 1}`;
    const renamed = await waitFor(currentJob, value => value?.title === desiredTitle, `The ${via} gesture did not restore directory permission and rename the file`);
    const targetInfos = (await browser.send('Target.getTargets')).targetInfos;
    assert.equal(targetInfos.some(target => target.url.startsWith(`chrome-extension://${id}/local-rename.html?`)), false, 'Saved handles must not force another directory authorization tab.');
    assert.equal(await hash(renamed.localFilePath), expectedHash);
    assert.equal(await stat(previousPath).then(() => true, () => false), false);
    const permission = await popup.evaluate(`(async()=>{const module=await import('./lib/local-downloads.js');return(await module.getSavedDirectory(${JSON.stringify(output)})).queryPermission({mode:'readwrite'});})()`);
    assert.equal(permission, 'granted');
    summary.push({ name: `actual-action-popup-${via}-restore`, before: stored.write, after: permission, noDirectoryPicker: true, nativeRenameCompleted: true, contentUnchanged: true });
    previousPath = renamed.localFilePath;
    if (index === 1) {
      const screenshot = await popup.call('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(results, 'permission-restored.png'), Buffer.from(screenshot.data, 'base64'));
    }
    await popup.close();
    console.log(`PASS 关闭全部插件页面 6.5 秒后权限为 ${stored.write}；真实 ${via} 操作直接恢复/复用并原地改名，无重复选目录`);
  }

  // Failure UI regressions intentionally inject permission/user-activation
  // responses only after the genuine restoration scenarios above have passed.
  await pause(6500);
  popup = await actionPopup();
  await popup.click('#jobs-tab');
  await waitFor(() => popup.evaluate('Boolean(document.querySelector(' + JSON.stringify(titleSelector) + '))'), Boolean, 'Completed title did not reopen');
  const unchangedTitle = (await currentJob()).title;
  await popup.evaluate(`(()=>{globalThis.testRenameRequests=0;const send=chrome.runtime.sendMessage.bind(chrome.runtime);chrome.runtime.sendMessage=(...args)=>{if(args[0]?.type==='RENAME_JOB')globalThis.testRenameRequests++;return send(...args);};const originalQuery=FileSystemHandle.prototype.queryPermission;FileSystemHandle.prototype.queryPermission=function(options){return options?.mode==='readwrite'?Promise.resolve('prompt'):originalQuery.call(this,options);};Object.defineProperty(navigator.userActivation,'isActive',{configurable:true,get:()=>false});return true;})()`);
  await popup.click(titleSelector);
  await popup.call('Input.insertText', {text:'缺失手势不能自动申请'});
  await popup.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await popup.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  const noActivationNotice=await waitFor(()=>popup.evaluate(`(()=>{const n=document.querySelector('#notice');return n&&!n.hidden&&n.classList.contains('is-error')?n.textContent:null;})()`), Boolean, 'Missing activation must show an explicit UI error');
  assert.match(noActivationNotice,/Enter/);
  assert.equal(await popup.evaluate('globalThis.testRenameRequests'),0);
  assert.equal((await currentJob()).title,unchangedTitle);
  assert.equal(await hash(previousPath),expectedHash);
  await popup.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await popup.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await popup.evaluate(`(()=>{delete navigator.userActivation.isActive;const query=FileSystemHandle.prototype.queryPermission;FileSystemHandle.prototype.queryPermission=function(options){return options?.mode==='readwrite'?Promise.resolve('denied'):query.call(this,options);};globalThis.testPermissionRequests=0;const request=FileSystemHandle.prototype.requestPermission;FileSystemHandle.prototype.requestPermission=function(options){globalThis.testPermissionRequests++;return request.call(this,options);};const notice=document.querySelector('#notice');notice.hidden=true;notice.textContent='';return true;})()`);
  await popup.click(titleSelector);
  await popup.call('Input.insertText',{text:'拒绝权限不能反复申请'});
  await popup.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await popup.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  const deniedNotice=await waitFor(()=>popup.evaluate(`(()=>{const n=document.querySelector('#notice');return n&&!n.hidden&&n.classList.contains('is-error')?n.textContent:null;})()`), Boolean, 'Denied permission must show an explicit UI error');
  assert.match(deniedNotice,/权限|授权/);
  assert.match(deniedNotice,/重新授权文件夹/);
  assert.equal(await popup.evaluate('globalThis.testRenameRequests'),0);
  assert.equal(await popup.evaluate('globalThis.testPermissionRequests'),0,'A deliberate denial must not cause repeated native requests.');
  assert.equal((await currentJob()).title,unchangedTitle);
  assert.equal(await hash(previousPath),expectedHash);
  assert.equal((await browser.send('Target.getTargets')).targetInfos.some(target=>target.url.startsWith(`chrome-extension://${id}/local-rename.html?`)),false,'Denied or missing activation must not automatically open another authorization page.');
  summary.push({name:'simulated-denied-and-missing-activation-UI',noNativePermissionRequests:true,noBackendRename:true,originalFileAndTitlePreserved:true,manualRecoveryAvailable:true});
  await popup.close();
  console.log('PASS 模拟缺失用户手势/拒绝权限时不反复申请、不提交改名、不自动打开授权页，保留原文件并提供主动恢复入口');

  await writeFile(path.join(results, 'result-' + firstGesture + '.json'), JSON.stringify({ firstGesture, testedAt: new Date().toISOString(), browser: version.product, filesystemGuardPregrant: false,
    scope: 'Real chrome.action.openPopup action popups, normal content settings, actual directory drag/drop and native permission restoration initiated by trusted input. Initial directory picking is represented by a real CDP directory drag; no native directory picker interaction is claimed.', tests: summary }, null, 2));
  console.log(`Permission lifecycle E2E passed: ${path.join(results, 'result.json')}`);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
}
