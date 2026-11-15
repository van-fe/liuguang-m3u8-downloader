import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareNativeDownloads, useNativeDownloads, loadExtension } from './e2e-downloads.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version;
const output = path.join(root, 'store', 'assets');
const workRoot = path.join(root, 'work', 'store-visuals');
const scratch = path.join(workRoot, String(Date.now()));
const fixtures = path.join(scratch, 'fixtures');
const profile = path.join(scratch, 'profile');
const temporary = path.join(scratch, 'temp');
const downloads = path.join(scratch, 'downloads');
await Promise.all([output, path.join(output, 'raw'), fixtures, temporary].map(directory => mkdir(directory, { recursive: true })));
process.env.TEMP = temporary;
process.env.TMP = temporary;
process.env.npm_config_cache = path.join(root, '.cache', 'npm');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('playwright');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const native = args => {
  const result = spawnSync('ffmpeg', args, { cwd: fixtures, encoding: 'utf8', windowsHide: true, env: { ...process.env }, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
};
native(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', path.join(fixtures, 'demo.m3u8')]);
native(['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(fixtures, 'demo.m3u8'), '-c', 'copy', '-movflags', '+faststart', path.join(fixtures, 'demo.mp4')]);
const mp4 = await readFile(path.join(fixtures, 'demo.mp4'));
const playlist = await readFile(path.join(fixtures, 'demo.m3u8'), 'utf8');
const held = new Map();
const fractions = { 'parallel-a.mp4': .42, 'parallel-b.mp4': .64, 'parallel-c.mp4': .28 };
const server = createServer(async (request, response) => {
  const url = new URL(request.url, 'http://localhost');
  response.setHeader('Access-Control-Allow-Origin', '*');
  try {
    if (url.pathname === '/page') {
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      response.end('<!doctype html><title>本地演示 · 色彩与声音</title><main><h1>流光本地演示</h1><p>所有媒体均由 FFmpeg 自生成，仅用于扩展界面展示。</p><script>fetch("/color-study.m3u8");fetch("/rhythm-study.m3u8");</script></main>');
      return;
    }
    const filename = path.basename(url.pathname);
    if (filename.endsWith('.m3u8')) {
      response.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      response.end(playlist);
      return;
    }
    if (filename in fractions) {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length });
      const offset = Math.floor(mp4.length * fractions[filename]);
      response.write(mp4.subarray(0, offset));
      held.set(filename, response);
      response.once('close', () => held.delete(filename));
      return;
    }
    if (/^demo\d+\.ts$/.test(filename)) {
      response.setHeader('Content-Type', 'video/mp2t');
      response.end(await readFile(path.join(fixtures, filename)));
      return;
    }
    response.writeHead(404).end();
  } catch { response.writeHead(500).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let context;
let chromeClosed = false;
const evidence = { version, media: 'FFmpeg self-generated testsrc2 video and sine audio', sources: [], files: [], pageErrors: [] };
async function waitFor(read, predicate, label, timeout = 45000) {
  const end = Date.now() + timeout;
  let value;
  while (Date.now() < end) {
    value = await read();
    if (predicate(value)) return value;
    await pause(50);
  }
  throw new Error(`${label}: ${JSON.stringify(value)}`);
}
const dataUri = bytes => `data:image/png;base64,${bytes.toString('base64')}`;
// Exact geometry/colors of the build's existing play mark, retained as vector
// so promotional artwork stays crisp when enlarged beyond the toolbar icon.
const icon = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect x="5.12" y="5.12" width="117.76" height="117.76" rx="25.6" fill="#17655e"/><path d="M49.92 32.32V95.68L92.16 64Z" fill="#f3f9f6"/></svg>').toString('base64')}`;
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const brand = `<div class="brand"><img src="${icon}"><strong>流光</strong><span>M3U8</span></div>`;
const pageBase = `<meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:"Microsoft YaHei","Segoe UI",sans-serif;color:#203d36;background:#f3f4ed}img{display:block}</style>`;
function screenshotHtml({ number, label, heading, description, tags, image, imageClass = '', footer }) {
  return `${pageBase}<style>
    body{background:radial-gradient(ellipse at 94% 12%,#d7e9df 0,transparent 48%),#f2f3ec}
    .wash{position:absolute;right:-150px;bottom:-300px;width:800px;height:800px;border-radius:50%;border:1px solid #c9ded2;box-shadow:0 0 0 90px #dce9df55,0 0 0 180px #dce9df33}
    .left{position:absolute;left:70px;top:58px;width:540px;height:686px}.brand{display:flex;align-items:center;gap:11px}.brand img{width:43px;height:43px}.brand strong{font-size:24px;letter-spacing:4px}.brand span{font-size:12px;letter-spacing:2px;color:#688378;margin-left:5px}
    .eyebrow{margin:62px 0 20px;font-size:15px;letter-spacing:3px;font-weight:600;color:#4c7b69}.eyebrow b{color:#13796d;letter-spacing:0;margin-right:11px}
    h1{font-size:52px;line-height:1.32;letter-spacing:1px;font-weight:750;margin:0;max-width:540px}h1 em{font-style:normal;color:#13796d}
    .description{font-size:20px;line-height:1.8;color:#62786f;margin-top:25px;max-width:470px}.tags{display:flex;gap:10px;flex-wrap:wrap;margin-top:31px}.tag{font-size:14px;line-height:1.5;padding:8px 13px;color:#336553;border:1px solid #c8d9cb;border-radius:8px;background:#fbfcf6b3}
    .footer{position:absolute;bottom:0;font-size:13px;line-height:1.85;color:#74867b;max-width:510px}.footer span{display:block;color:#8a998c;font-size:12px;margin-top:6px}
    .shot{position:absolute;left:705px;top:60px;max-height:680px;width:484px;border:1px solid #d7e1d4;border-radius:19px;background:#f6f7f0;overflow:hidden;box-shadow:0 24px 65px #254d3420,0 4px 16px #254d340c}.shot img{width:100%;height:auto}.shot.parallel{top:60px;left:705px;width:484px}.shot.settings{left:674px;top:164px;width:536px;padding:27px;border-radius:22px}.shot.settings img{border-radius:0}.shot.naming{top:70px}
    .rule{position:absolute;left:70px;right:70px;bottom:31px;height:1px;background:#d9e1d7}
  </style><div class="wash"></div><div class="left">${brand}<div class="eyebrow"><b>${number}</b>${escape(label)}</div><h1>${heading}</h1><p class="description">${description}</p><div class="tags">${tags.map(tag => `<div class="tag">${escape(tag)}</div>`).join('')}</div><div class="footer">${footer}<span>界面使用本地自生成演示媒体。仅下载您拥有权利或已获授权的内容。</span></div></div><div class="shot ${imageClass}"><img src="${image}"></div>`;
}
async function render(page, html, filename, width, height, transparent = false) {
  await page.setViewportSize({ width, height });
  await page.setContent(html);
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map(image => image.decode())); });
  const bytes = await page.screenshot({ path: path.join(output, filename), omitBackground: transparent });
  assert.equal(bytes.readUInt32BE(16), width);
  assert.equal(bytes.readUInt32BE(20), height);
  evidence.files.push({ filename, width, height, bytes: bytes.length });
}
try {
  await prepareNativeDownloads(profile, downloads);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ignoreDefaultArgs: ['--disable-extensions'], headless: true, args: ['--enable-unsafe-extension-debugging'],
    viewport: { width: 440, height: 900 }, deviceScaleFactor: 1,
    acceptDownloads: true, downloadsPath: downloads, env: { ...process.env, TEMP: temporary, TMP: temporary },
  });
  context.on('weberror', event => evidence.pageErrors.push(event.error().message));
  const cdp = await context.browser().newBrowserCDPSession();
  await useNativeDownloads(cdp);
  const { id, worker } = await loadExtension(context, cdp, path.join(root, 'dist', 'liuguang-m3u8'));
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), version);
  const demoPage = await context.newPage();
  await demoPage.goto(`${base}/page`);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, `${base}/page`);
  const popup = await context.newPage();
  await demoPage.bringToFront();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  const send = (type, data = {}) => popup.evaluate(message => chrome.runtime.sendMessage({ target: 'background', ...message }), { type, ...data });
  const state = () => send('GET_STATE', { tabId });
  let detected = await waitFor(state, value => value.streams.length >= 2, 'Local HLS sources were not detected');
  const names = { '/color-study.m3u8': '本地演示 · 色彩与声音', '/rhythm-study.m3u8': '本地演示 · 画面节奏练习' };
  for (const stream of detected.streams) {
    const title = names[new URL(stream.url).pathname];
    if (title) assert.equal((await send('RENAME_STREAM', { tabId, streamId: stream.id, title })).ok, true);
  }
  await popup.locator('#streams-tab').click();
  await popup.waitForFunction(() => document.querySelectorAll('.stream-card').length >= 2 && [...document.querySelectorAll('.stream-title-button')].some(node => node.textContent.includes('色彩与声音')));
  await popup.evaluate(() => window.scrollTo(0, 0));
  await pause(200);
  const discovery = await popup.screenshot({ path: path.join(output, 'raw', 'discovery.png'), clip: { x: 0, y: 0, width: 440, height: 600 } });
  const titleButton = popup.locator('.stream-title-button').filter({ hasText: '色彩与声音' });
  await titleButton.click();
  const editor = popup.locator('.stream-title-input');
  await editor.fill('本地演示 · 我的色彩练习');
  await popup.evaluate(() => window.scrollTo(0, 0));
  const naming = await popup.screenshot({ path: path.join(output, 'raw', 'naming.png'), clip: { x: 0, y: 0, width: 440, height: 600 } });
  await editor.press('Enter');
  await popup.waitForFunction(() => document.querySelector('#notice').hidden, null, { timeout: 9000 });
  const completed = await send('START_DOWNLOAD', { tabId, url: `${base}/saved-example.m3u8`, title: '本地演示 · 已保存的练习', saveAs: false });
  assert.equal(completed.ok, true, completed.error);
  await waitFor(state, value => value.jobs.find(job => job.id === completed.jobId)?.status === 'complete', 'Real HLS example did not save');
  const titles = ['本地演示 · 色彩练习 A', '本地演示 · 节奏练习 B', '本地演示 · 音画练习 C'];
  for (const [index, filename] of Object.keys(fractions).entries()) {
    const result = await send('START_DOWNLOAD', { tabId, url: `${base}/${filename}`, title: titles[index], saveAs: false });
    assert.equal(result.ok, true, result.error);
  }
  await waitFor(state, value => value.jobs.filter(job => job.status === 'downloading' && job.bytes > 0).length === 3, 'Three real partial downloads did not overlap');
  assert.equal(held.size, 3);
  evidence.actualConcurrentTransfers = held.size;
  await popup.locator('#jobs-tab').click();
  await popup.waitForFunction(() => document.querySelectorAll('.job-card .job-state.downloading').length === 3);
  await popup.evaluate(() => window.scrollTo(0, 0));
  await pause(200);
  const parallel = await popup.screenshot({ path: path.join(output, 'raw', 'parallel.png'), clip: { x: 0, y: 0, width: 440, height: 600 } });
  await popup.locator('#auto-save').check();
  await waitFor(state, value => value.settings.saveAs === false, 'Automatic save did not persist');
  const settings = await popup.locator('section.preferences').screenshot({ path: path.join(output, 'raw', 'settings.png') });
  evidence.sources.push({ filename: 'raw/discovery.png', origin: 'actual production popup, real automatic HLS detection' }, { filename: 'raw/parallel.png', origin: 'actual production popup, 3 genuine partial MP4 responses; 1 real HLS conversion completed before capture' }, { filename: 'raw/settings.png', origin: 'actual production preferences section' }, { filename: 'raw/naming.png', origin: 'actual production discovery name editor, user input before confirmation' });
  assert.deepEqual(evidence.pageErrors, []);
  await send('CLEAR_JOBS');
  const designPage = await context.newPage();
  const features = [
    { filename: 'screenshot-01-discovery-1280x800.png', number: '01', label: '发现视频', heading: '发现网页视频<br>保存为<em>本地 MP4</em>', description: '在网页中播放视频，流光自动识别<br>可下载的 HLS 视频源。', tags: ['自动检测', '预览确认', 'MP4 保存'], image: dataUri(discovery), footer: '播放 → 发现 → 下载，保留清晰的操作路径。' },
    { filename: 'screenshot-02-parallel-1280x800.png', number: '02', label: '下载任务', heading: '多个任务<br><em>一起下载</em>', description: '每个任务独立显示进度，<br>单独取消，不打断其他下载。', tags: ['任务数量无上限', '独立进度', '后台继续'], image: dataUri(parallel), imageClass: 'parallel', footer: '画面中 3 个 MP4 任务正在真实并行传输。' },
    { filename: 'screenshot-03-local-settings-1280x800.png', number: '03', label: '本机处理', heading: '保存方式<br><em>由你选择</em>', description: '按 Chrome 设置自动保存，<br>或在保存时选择位置和名称。', tags: ['本地合并', '分片并发', '失败重试'], image: dataUri(settings), imageClass: 'settings', footer: '视频处理在本机完成，不上传到开发者服务器。' },
    { filename: 'screenshot-04-naming-1280x800.png', number: '04', label: '名称编辑', heading: '下载之前<br><em>先取好名字</em>', description: '点击名称直接编辑，<br>也可以使用当前网页标题。', tags: ['点击改名', 'Enter 保存', 'Esc 取消'], image: dataUri(naming), imageClass: 'naming', footer: '确认名称后保存，方便整理自己的视频文件。' },
  ];
  for (const feature of features) await render(designPage, screenshotHtml(feature), feature.filename, 1280, 800);
  await render(designPage, `${pageBase}<style>body{background:transparent}.icon{position:absolute;left:12px;top:12px;width:104px;height:104px}</style><img class="icon" src="${icon}">`, 'icon-128.png', 128, 128, true);
  const waves = `<svg viewBox="0 0 1400 560" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%"><g fill="none" stroke="#75bca4" stroke-width="1" opacity=".24"><ellipse cx="1120" cy="95" rx="380" ry="240"/><ellipse cx="1120" cy="95" rx="450" ry="290"/><ellipse cx="1120" cy="95" rx="520" ry="340"/><ellipse cx="1120" cy="95" rx="590" ry="390"/></g><circle cx="220" cy="500" r="260" fill="#3b8c77" opacity=".16"/></svg>`;
  await render(designPage, `${pageBase}<style>body{background:#145e52;color:#f8f8e9}.mark{position:absolute;width:124px;height:124px;left:158px;top:48px;filter:drop-shadow(0 12px 24px #0b3f3555)}.wordmark{position:absolute;top:188px;width:100%;text-align:center;font-size:29px;letter-spacing:12px;font-weight:650;padding-left:12px}.dot{position:absolute;border:1px solid #87baa144;border-radius:50%;width:260px;height:260px;left:90px;top:-20px}</style>${waves}<div class="dot"></div><img class="mark" src="${icon}"><div class="wordmark">流光</div>`, 'promo-440x280.png', 440, 280);
  await render(designPage, `${pageBase}<style>body{background:#145e52;color:#fffdef}.mark{position:absolute;left:161px;top:135px;width:244px;height:244px;filter:drop-shadow(0 24px 40px #073d3255)}.wordmark{position:absolute;left:487px;top:174px;font-size:74px;letter-spacing:17px;font-weight:700;line-height:1.3}.subtitle{position:absolute;left:492px;top:290px;font-size:25px;letter-spacing:5px;color:#bbd7c5}.line{position:absolute;left:492px;top:366px;width:380px;height:1px;background:#8bb49e55}</style>${waves}<img class="mark" src="${icon}"><div class="wordmark">流光</div><div class="subtitle">发现视频，留住精彩。</div><div class="line"></div>`, 'marquee-1400x560.png', 1400, 560);
  evidence.officialImageRequirements = 'https://developer.chrome.com/docs/webstore/images';
  evidence.screenshotPolicy = 'Composites use unmodified real UI captures; only surrounding editorial layout is generated. Demo media is self-generated. No user browser data or copyrighted third-party media is used.';
  await writeFile(path.join(output, 'asset-manifest.json'), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(output, 'ASSETS.txt'), `流光 Chrome 应用商店图片\n\n版本：${version}\n\n推荐按 01→04 顺序上传四张 1280×800 截图。icon-128.png 为带透明留白的商店图标，请在发布包 assets/icon128.png 中使用同一文件。promo-440x280.png 与 marquee-1400x560.png 为可选宣传图。\n\n截图中的界面直接来自实际扩展；raw/ 中保留原始截图。界面内视频来自 FFmpeg 自生成的测试图形与正弦音频，不包含第三方影视素材。外围排版为商店展示说明，不是新增产品界面。\n\n重新生成：先构建最终扩展，然后运行 node scripts/store-visuals.mjs。\n官方尺寸依据：https://developer.chrome.com/docs/webstore/images\n`);
  console.log(`Generated ${evidence.files.length} store assets from actual extension ${version}: ${output}`);
} finally {
  for (const response of held.values()) response.destroy();
  if (context) { await context.close(); chromeClosed = true; }
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (chromeClosed) {
    const resolved = path.resolve(scratch);
    assert.ok(resolved.startsWith(path.resolve(workRoot) + path.sep) && resolved.startsWith(root + path.sep));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
