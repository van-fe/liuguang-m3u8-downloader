import { mkdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.join(root, '.cache', 'ms-playwright');
const { chromium } = await import('playwright');
const runId = process.env.SITE_RUN_ID || `probe-${Date.now()}`;
const output = path.join(root, 'test-results', 'sites', runId);
await mkdir(output, { recursive: true });
const targets = process.argv.slice(2);
const context = await chromium.launchPersistentContext(path.join(root, `.site-test-profile-${runId}`), {
  executablePath: process.env.E2E_CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ignoreDefaultArgs: ['--disable-extensions'], headless: true,
  args: ['--enable-unsafe-extension-debugging'],
  acceptDownloads: true, downloadsPath: path.join(output, 'downloads'), viewport: { width: 1280, height: 800 }
});
try {
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Extensions.loadUnpacked', { path: path.join(root, 'dist', 'liuguang-m3u8') });
  const worker = context.serviceWorkers().find(item => item.url().endsWith('/background.js')) || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.webRequest.onHeadersReceived.hasListeners());
  const extensionId = new URL(worker.url()).hostname;
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const reports = [];
  for (const url of targets) {
    console.log(`OPEN ${url}`);
    const page = await context.newPage();
    const observed = [], failed = [];
    page.on('response', async response => {
      const type = response.headers()['content-type'] || '';
      if (/mpegurl|dash\+xml|video\//i.test(type) || /\.m3u8|\.mpd|\.m4s|\.flv|\.mp4(?:\?|$)/i.test(response.url())) {
        if (observed.length < 70) observed.push({ url: response.url(), status: response.status(), type });
      }
    });
    page.on('requestfailed', request => { if (failed.length < 12) failed.push({ url: request.url(), error: request.failure()?.errorText }); });
    let navigationError;
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 }); }
    catch (error) { navigationError = error.message; }
    await page.waitForTimeout(6000);
    for (const frame of page.frames()) {
      await frame.evaluate(() => { for (const video of document.querySelectorAll('video')) { video.muted = true; video.play().catch(() => {}); } }).catch(() => {});
      const play = frame.getByRole('button', { name: /^(play|play video|播放|播放视频|开始播放)$/i }).first();
      if (await play.isVisible().catch(() => false)) await play.click({ timeout: 3000 }).catch(() => {});
    }
    await page.waitForTimeout(6000);
    const tabId = await worker.evaluate(async pageUrl => (await chrome.tabs.query({})).find(tab => tab.url === pageUrl)?.id, page.url());
    const state = await popup.evaluate(tabId => chrome.runtime.sendMessage({ target: 'background', type: 'GET_STATE', tabId }), tabId);
    const dom = await page.evaluate(() => ({
      title: document.title,
      text: document.body?.innerText.slice(0, 2800),
      buttons: [...document.querySelectorAll('button')].map(button => ({ text: button.innerText.slice(0, 80), label: button.getAttribute('aria-label') })).slice(0, 50),
      inputs: [...document.querySelectorAll('input,select')].map(input => ({ tag: input.tagName, id: input.id, type: input.type, value: input.value?.slice(0, 300) })).slice(0, 25),
      videos: [...document.querySelectorAll('video')].map(video => ({ src: video.currentSrc, time: video.currentTime, ready: video.readyState, duration: video.duration, error: video.error?.message })),
      links: [...document.querySelectorAll('a[href]')].filter(link => /m3u8|\/w\/|\/video\/|youtu|vimeo/i.test(link.href)).map(link => ({ text: link.innerText.slice(0, 60), url: link.href })).slice(0, 40)
    })).catch(error => ({ error: error.message }));
    const report = { inputUrl: url, finalUrl: page.url(), tabId, navigationError, detected: state.streams || [], observed, failed, dom };
    const index = reports.push(report);
    await page.screenshot({ path: path.join(output, `probe-${index}.png`), fullPage: false }).catch(() => {});
    await writeFile(path.join(output, 'probe.json'), JSON.stringify(reports, null, 2));
    console.log(JSON.stringify({ inputUrl: url, finalUrl: page.url(), title: dom.title, navigationError, detectedCount: report.detected.length, mediaResponses: observed.length, video: dom.videos, message: dom.text?.slice(0, 250) }));
    await page.close();
  }
} finally { await context.close(); }
