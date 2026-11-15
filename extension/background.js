import { getXPostId, isXPageUrl, isXMediaUrl, selectXVariant } from './lib/x-media.js';
import { resolveXPost } from './lib/x-resolver.js';
import { createDiagnosticStore } from './lib/diagnostic-store.js';
import { createDownloadNameStore, isOwnDownloadBlob } from './lib/download-names.js';
import { sanitizeFilename } from './lib/hls.js';
import { getStreamTitle } from './lib/stream-names.js';
import { getLocalDownloadInfo, renameLocalDownload } from './lib/local-downloads.js';

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');
const POPUP_URL = chrome.runtime.getURL('popup.html');
const PREVIEW_URL = chrome.runtime.getURL('preview.html');
const ACTIVE = new Set(['queued', 'preparing', 'downloading', 'converting', 'saving']);
const TERMINAL = new Set(['complete', 'error', 'cancelled']);
const DEFAULT_SETTINGS = { saveAs: true, taskConcurrency: 'unlimited', concurrency: 4, retries: 3 };
const state = { streamsByTab: {}, jobs: [], settings: { ...DEFAULT_SETTINGS } };
let mutations = Promise.resolve();
let creatingOffscreen;
const xLookups = new Map();
const streamVersions = new Map();
const suppressedStreamLookups = new Set();
const diagnosticStore = createDiagnosticStore(chrome.storage.local);
const downloadNames = createDownloadNameStore(chrome.storage.session, { extensionId: chrome.runtime.id });
const anchorSaves = new Map();

chrome.downloads.onCreated.addListener(item => { void handleAnchorCreated(item).catch(() => {}); });

const videoFormat = url => /\.mp4$/i.test(new URL(url).pathname) ? 'mp4' : 'hls';
const xMediaKey = url => /\/(?:ext_tw_video|amplify_video|tweet_video)\/([^/]+)/.exec(new URL(url).pathname)?.[1];
function mergeXVariants(values) {
  const unique = new Map();
  for (const value of values.slice(0, 200)) {
    const variant = selectXVariant([value]);
    if (!variant) continue;
    const previous = unique.get(variant.url);
    unique.set(variant.url, previous ? { ...variant, bitrate: Math.max(previous.bitrate, variant.bitrate), width: Math.max(previous.width, variant.width), height: Math.max(previous.height, variant.height) } : variant);
  }
  return [...unique.values()].slice(0, 100);
}

const isHttpUrl = (value) => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; }
  catch { return false; }
};

const isPlaylistUrl = (value) => {
  try {
    const url = new URL(value);
    let pathname = url.pathname;
    try { pathname = decodeURIComponent(pathname); } catch { /* Preserve malformed escaped paths for matching. */ }
    return ['http:', 'https:'].includes(url.protocol) && /\.m3u8(?:$|\/)/i.test(pathname);
  } catch { return false; }
};

const hasOffscreen = async () => (await chrome.runtime.getContexts({
  contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [OFFSCREEN_URL]
})).length > 0;

const ready = (async () => {
  const [session, local] = await Promise.all([
    chrome.storage.session.get(['streamsByTab', 'jobs', 'suppressedStreamLookupTabs']), chrome.storage.local.get('settings')
  ]);
  state.streamsByTab = session.streamsByTab || {};
  state.jobs = session.jobs || [];
  for (const tabId of session.suppressedStreamLookupTabs || []) {
    if (Number.isInteger(tabId) && tabId >= 0) suppressedStreamLookups.add(tabId);
  }
  state.settings = { ...DEFAULT_SETTINGS, ...local.settings };
  state.settings.taskConcurrency = DEFAULT_SETTINGS.taskConcurrency;
  if (local.settings && local.settings.taskConcurrency !== DEFAULT_SETTINGS.taskConcurrency) {
    await chrome.storage.local.set({ settings: state.settings });
  }
  if (!(await hasOffscreen())) {
    for (const job of state.jobs) {
      if (!ACTIVE.has(job.status)) continue;
      if (job.downloadId != null) {
        const [download] = await chrome.downloads.search({ id: job.downloadId });
        if (download?.state === 'complete') {
          Object.assign(job, { status: 'complete', progress: 100 });
          continue;
        }
      }
      Object.assign(job, { status: 'error', error: '浏览器或插件已重启，下载已中断，请重新下载。' });
    }
    await chrome.storage.session.set({ jobs: state.jobs });
  }
})().catch((error) => console.error('初始化失败', error));

function mutate(callback) {
  const next = mutations.then(async () => {
    await ready;
    const result = await callback();
    // Preserve all active jobs while bounding completed history.
    let terminalCount = 0;
    state.jobs = state.jobs.filter((job) => !TERMINAL.has(job.status) || ++terminalCount <= 30);
    await chrome.storage.session.set({ streamsByTab: state.streamsByTab, jobs: state.jobs, suppressedStreamLookupTabs: [...suppressedStreamLookups] });
    return result;
  });
  mutations = next.catch((error) => console.error('状态更新失败', error));
  return next;
}

const streamVersion = tabId => streamVersions.get(tabId) || 0;
function clearTabStreams(tabId) {
  streamVersions.set(tabId, streamVersion(tabId) + 1);
  delete state.streamsByTab[tabId];
  return streamVersion(tabId);
}

function findStream(tabId, streamId) {
  if (!Number.isInteger(tabId) || tabId < 0 || typeof streamId !== 'string') throw new Error('视频源不存在或已被清除，请重新检测。');
  const stream = state.streamsByTab[tabId]?.find(entry => entry.id === streamId);
  if (!stream) throw new Error('视频源不存在或已被清除，请重新检测。');
  return stream;
}

function safeTitle(value, allowEmpty = false, label = '文件名') {
  if (typeof value !== 'string' || (!value.trim() && !allowEmpty)) throw new Error(`请输入${label}。`);
  if (!value.trim()) return '';
  const stem = value.trim().replace(/\.mp4$/i, '').trim();
  if (!stem || !/[^\s.\u0000-\u001f\u007f<>:"/\\|?*]/u.test(stem)) throw new Error(`请输入有效的${label}。`);
  return sanitizeFilename(value).slice(0, -4);
}

async function readPageTitle(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('请先打开视频网页。');
  let results;
  try { results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => document.title }); }
  catch { throw new Error('无法读取当前网页标题，请确认网页仍然打开。'); }
  const title = results?.find(entry => entry.frameId === 0)?.result ?? results?.[0]?.result;
  if (typeof title !== 'string' || !title.trim()) throw new Error('当前网页没有标题，请手动填写文件名。');
  return safeTitle(title);
}

async function updateBadge(tabId) {
  const count = state.streamsByTab[tabId]?.length || 0;
  await Promise.allSettled([
    chrome.action.setBadgeText({ tabId, text: count ? String(count) : '' }),
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#147d73' })
  ]);
}

async function detect(tabId, urls, title) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const candidates = urls.filter(isHttpUrl).slice(0, 80);
  if (!candidates.length) return;
  await mutate(() => {
    const streams = state.streamsByTab[tabId] ||= [];
    for (const url of candidates) {
      const existing = streams.find((stream) => stream.url === url);
      if (existing) {
        if (title) existing.title = String(title).slice(0, 200);
        continue;
      }
      if (streams.length >= 80) break;
      streams.unshift({
        id: crypto.randomUUID(), url, title: String(title || '网页视频').slice(0, 200),
        hostname: new URL(url).hostname, format: videoFormat(url), detectedAt: Date.now()
      });
    }
  });
  await updateBadge(tabId);
}

async function detectX(tabId, items, fallback = {}, version = streamVersion(tabId)) {
  if (!Number.isInteger(tabId) || tabId < 0 || !Array.isArray(items)) return [];
  const accepted = [];
  await mutate(() => {
    if (version !== streamVersion(tabId)) return;
    let streams = state.streamsByTab[tabId] ||= [];
    for (const [itemIndex, item] of items.slice(0, 25).entries()) {
      if (!item || typeof item !== 'object') continue;
      const incoming = (Array.isArray(item.variants) ? item.variants : [{ url: item.url, type: item.format }]).slice(0, 100).filter(variant => isXMediaUrl(variant?.url));
      if (!incoming.length) continue;
      const keys = new Set(incoming.map(variant => xMediaKey(variant.url)).filter(Boolean));
      const existing = streams.find(stream => stream.platform === 'x' && (String(stream.mediaId) === String(item.mediaId || item.id) || keys.has(xMediaKey(stream.url))))
        || streams.find(stream => incoming.some(variant => variant.url === stream.url));
      const variants = mergeXVariants([...(existing?.variants || []), ...incoming]);
      const selected = selectXVariant(variants);
      if (!selected) continue;
      const postId = /^\d{1,25}$/.test(String(item.postId || '')) ? String(item.postId) : existing?.postId || getXPostId(fallback.postUrl);
      const title = String(item.title || existing?.title || fallback.title || 'X 视频').slice(0, 200);
      const mediaId = String(item.mediaId || item.id || existing?.mediaId || xMediaKey(selected.url) || crypto.randomUUID()).slice(0, 100);
      const record = {
        id: existing?.id || `x-${mediaId}`, mediaId, platform: 'x', postId: postId || null,
        mediaIndex: Number.isInteger(item.mediaIndex) ? item.mediaIndex : (Array.isArray(item.variants) ? itemIndex : existing?.mediaIndex ?? itemIndex),
        metadataComplete: item.metadataComplete === false ? Boolean(existing?.metadataComplete) : Array.isArray(item.variants) || existing?.metadataComplete || false,
        postUrl: postId ? `https://x.com/i/status/${postId}` : null,
        title, url: selected.url, format: selected.type, variants,
        ...(existing && Object.hasOwn(existing, 'customTitle') ? { customTitle: existing.customTitle } : {}),
        hostname: new URL(selected.url).hostname, detectedAt: existing?.detectedAt || Date.now()
      };
      // A player's HLS child requests must not replace the parent or selected MP4.
      streams = streams.filter(stream => stream.id !== existing?.id && !(isXMediaUrl(stream.url) && keys.has(xMediaKey(stream.url))));
      streams.unshift(record);
      streams = streams.slice(0, 80);
      accepted.push(record);
    }
    state.streamsByTab[tabId] = streams;
  });
  await updateBadge(tabId);
  return accepted;
}

async function xPostMedia(url, tabId, version = streamVersion(tabId)) {
  const postId = getXPostId(url);
  if (!postId) throw new Error('请使用完整的 X 帖子链接');
  const copies = new Map();
  for (const stream of Object.values(state.streamsByTab).flat().filter(stream => stream.platform === 'x' && stream.postId === postId)) {
    const previous = copies.get(stream.mediaId);
    if (!previous) { copies.set(stream.mediaId, stream); continue; }
    const metadata = previous.metadataComplete && !stream.metadataComplete ? previous : stream;
    const variants = mergeXVariants([...(previous.variants || []), ...(stream.variants || [])]);
    const selected = selectXVariant(variants);
    copies.set(stream.mediaId, { ...metadata, variants, url: selected?.url || metadata.url, format: selected?.type || metadata.format });
  }
  const cached = [...copies.values()]
    .sort((left, right) => (left.mediaIndex ?? 0) - (right.mediaIndex ?? 0));
  if (cached.length && cached.every(item => item.metadataComplete)) return Number.isInteger(tabId) && tabId >= 0 ? detectX(tabId, cached, {}, version) : cached;
  const pending = xLookups.get(postId);
  const promise = pending && Date.now() - pending.time < 60000 ? pending.promise : resolveXPost(url, { fetchImpl: fetch });
  if (!pending || Date.now() - pending.time >= 60000) xLookups.set(postId, { time: Date.now(), promise });
  if (xLookups.size > 50) xLookups.delete(xLookups.keys().next().value);
  let items;
  try { items = await promise; }
  catch (error) { if (!cached.length) throw error; items = cached; }
  return Number.isInteger(tabId) && tabId >= 0 ? detectX(tabId, items, {}, version) : items.map(item => ({ ...item, platform: 'x' }));
}

async function requestedSource(message, { requireTitle = false } = {}) {
  await mutations;
  if (!isHttpUrl(message.url)) throw new Error('请输入有效的视频或 X 帖子地址。');
  let preview;
  if (message.previewId != null) {
    const saved = await chrome.storage.session.get('previewSources');
    preview = typeof message.previewId === 'string' ? saved.previewSources?.[message.previewId] : null;
    if (!preview || preview.url !== message.url || preview.tabId !== message.tabId || preview.streamId !== message.streamId) {
      throw new Error('预览链接已失效，请从插件重新打开预览。');
    }
  }
  if (message.streamId != null) {
    const item = state.streamsByTab[message.tabId]?.find(entry => entry.id === message.streamId) || preview;
    if (!item) findStream(message.tabId, message.streamId);
    const title = getStreamTitle(item);
    if (requireTitle && !title) throw new Error('请先填写文件名或使用网页标题。');
    return { ...item, streamId: message.streamId, title };
  }
  if (preview) {
    const title = getStreamTitle(preview);
    if (requireTitle && !title) throw new Error('请先填写文件名或使用网页标题。');
    return { ...preview, title };
  }
  if (isXPageUrl(message.url)) {
    const items = await xPostMedia(message.url, message.tabId);
    if (!items.length) throw new Error('这条 X 帖子中没有可下载的视频');
    const index = Math.max(0, Number(/\/video\/(\d+)/.exec(new URL(message.url).pathname)?.[1] || 1) - 1);
    const item = items[index] || items[0];
    return { ...item, title: item.customTitle || message.title || item.title || 'X 视频' };
  }
  const item = state.streamsByTab[message.tabId]?.find(stream => stream.url === message.url);
  return { ...item, url: message.url, format: item?.format || videoFormat(message.url), title: item?.customTitle || message.title || item?.title || '网页视频' };
}

chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (details.tabId >= 0 && details.type === 'main_frame') {
    const version = streamVersion(details.tabId) + 1;
    streamVersions.set(details.tabId, version);
    mutate(() => { suppressedStreamLookups.delete(details.tabId); delete state.streamsByTab[details.tabId]; }).then(async () => {
      await updateBadge(details.tabId);
      // A public post may redirect to X's sign-in page before content scripts run.
      // Read only the same public embedded-post metadata used for pasted links.
      if (getXPostId(details.url) && version === streamVersion(details.tabId)) await xPostMedia(details.url, details.tabId, version);
    }).catch(() => {});
  }
  if (details.tabId >= 0 && isXMediaUrl(details.url)) {
    const version = streamVersion(details.tabId);
    chrome.tabs.get(details.tabId).then(tab => detectX(details.tabId, [{
      id: xMediaKey(details.url), url: details.url, format: videoFormat(details.url), postId: getXPostId(tab.url)
    }], { postUrl: tab.url, title: tab.title }, version)).catch(console.error);
  } else if (details.tabId >= 0 && isPlaylistUrl(details.url)) {
    detect(details.tabId, [details.url]).catch(console.error);
  }
}, { urls: ['http://*/*', 'https://*/*'] });

chrome.webRequest.onHeadersReceived.addListener((details) => {
  if (details.tabId < 0) return;
  if (isXMediaUrl(details.url)) return;
  const contentType = details.responseHeaders?.find((header) => header.name.toLowerCase() === 'content-type')?.value;
  if (contentType && /(?:application\/(?:vnd\.apple\.mpegurl|x-mpegurl)|audio\/(?:x-)?mpegurl)/i.test(contentType)) {
    detect(details.tabId, [details.url]).catch(console.error);
  }
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && !isHttpUrl(changeInfo.url)) {
    mutate(() => { suppressedStreamLookups.delete(tabId); clearTabStreams(tabId); }).then(() => updateBadge(tabId)).catch(console.error);
  }
  if (changeInfo.title) {
    mutate(() => {
      for (const stream of state.streamsByTab[tabId] || []) stream.title = tab.title?.slice(0, 200) || stream.title;
    }).catch(console.error);
  }
  if (changeInfo.status === 'complete' && getXPostId(tab.url)) void xPostMedia(tab.url, tabId).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mutate(() => { suppressedStreamLookups.delete(tabId); clearTabStreams(tabId); }).catch(console.error);
});

async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  if (await hasOffscreen()) return;
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = chrome.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['BLOBS'],
    justification: '下载视频分片，在本地 WebAssembly 工作线程中封装 MP4，并生成供浏览器保存的 Blob。'
  });
  try { await creatingOffscreen; }
  finally { creatingOffscreen = undefined; }
}

async function offscreenMessage(message) {
  return chrome.runtime.sendMessage({ target: 'offscreen', ...message });
}

async function releaseBlob(jobId) {
  try { await offscreenMessage({ type: 'RELEASE_BLOB', jobId }); }
  catch { /* A closed offscreen document already released its resources. */ }
}

// Mark the same object before removing it so pending API saves still see cancellation.
function cancelJobState(job) {
  if (!job || !ACTIVE.has(job.status)) return false;
  job.status = 'cancelled';
  job.updatedAt = Date.now();
  return true;
}

async function stopCancelledJob(job) {
  for (const waiting of anchorSaves.values()) {
    if (waiting.jobId === job.id) waiting.finish(new Error('下载任务已结束。'));
  }
  await diagnosticStore.mark(job.id, { status: 'cancelled', updatedAt: Date.now(), completedAt: Date.now() }).catch(console.error);
  if (job.downloadId != null) await chrome.downloads.cancel(job.downloadId).catch(() => {});
  await offscreenMessage({ type: 'CANCEL_JOB', jobId: job.id }).catch(() => {});
  await releaseBlob(job.id);
}

function waitForAnchor(url, jobId) {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  // Cancellation can arrive while the offscreen acknowledgement is still pending.
  promise.catch(() => {});
  const timer = setTimeout(() => finish(new Error('文件保存未启动，请重新下载。')), 15000);
  const finish = (error, downloadId) => {
    if (anchorSaves.get(url)?.promise !== promise) return;
    anchorSaves.delete(url);
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(downloadId);
  };
  const waiting = { jobId, promise, finish };
  anchorSaves.set(url, waiting);
  return waiting;
}

async function handleAnchorCreated(item) {
  await ready;
  const registered = await downloadNames.match(item);
  if (!registered) return;
  let acceptedJob;
  await mutate(() => {
    const job = state.jobs.find(entry => entry.id === registered.jobId);
    if (!job || !ACTIVE.has(job.status) || (job.downloadId != null && job.downloadId !== item.id)) return;
    job.downloadId = item.id;
    acceptedJob = job;
  });
  if (!acceptedJob) {
    await chrome.downloads.cancel(item.id).catch(() => {});
    await downloadNames.remove(registered.url).catch(() => {});
    anchorSaves.get(registered.url)?.finish(new Error('下载任务已结束。'));
    await releaseBlob(registered.jobId);
    return;
  }
  if (acceptedJob.status === 'cancelled') await chrome.downloads.cancel(item.id).catch(() => {});
  // Tiny files may complete before onCreated finishes binding the job.
  const [download] = await chrome.downloads.search({ id: item.id }).catch(() => []);
  if (download) await reconcileDownload(item.id, download.state, download.error);
  anchorSaves.get(registered.url)?.finish(null, item.id);
}

async function reconcileDownload(downloadId, downloadState, error) {
  let jobId;
  let diagnosticPatch;
  await mutate(() => {
    const job = state.jobs.find((entry) => entry.downloadId === downloadId);
    if (!job) return;
    jobId = job.id;
    if (job.status === 'cancelled') return;
    if (downloadState === 'complete') Object.assign(job, { status: 'complete', progress: 100, error: null });
    if (downloadState === 'interrupted') Object.assign(job, {
      status: 'error', error: error === 'FILE_NO_SPACE' ? '下载目标磁盘空间不足，请释放空间后重新下载。' : `文件保存未完成：${error || '下载被中断，请重新下载。'}`
    });
    if (['complete', 'interrupted'].includes(downloadState)) diagnosticPatch = {
      status: job.status, updatedAt: Date.now(), completedAt: Date.now(),
      ...(job.status === 'error' ? { failure: { stage: 'saving', name: 'DownloadError', message: job.error } } : {})
    };
  });
  if (['complete', 'interrupted'].includes(downloadState)) void downloadNames.complete(downloadId).catch(() => {});
  if (diagnosticPatch) await diagnosticStore.mark(jobId, diagnosticPatch).catch(console.error);
  if (jobId && ['complete', 'interrupted'].includes(downloadState)) await releaseBlob(jobId);
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  reconcileDownload(delta.id, delta.state.current, delta.error?.current).catch(console.error);
});

function requirePopup(sender) {
  if (sender.url !== POPUP_URL && !sender.url?.startsWith(`${PREVIEW_URL}?`)) throw new Error('此操作只能从插件窗口发起。');
}

async function localRenameRequests() {
  const saved = await chrome.storage.session.get('localRenameRequests');
  return Object.entries(saved.localRenameRequests || {}).filter(([, entry]) => entry && Date.now() - entry.createdAt < 30 * 60 * 1000);
}

async function localRenameTicket(id) {
  if (typeof id !== 'string') throw new Error('改名请求已失效，请从下载任务重新操作。');
  const entry = (await localRenameRequests()).find(([key]) => key === id)?.[1];
  const job = entry && state.jobs.find(item => item.id === entry.jobId);
  if (!entry || !job || job.status !== 'complete') throw new Error('改名请求已失效，任务可能已被移除，请从下载任务重新操作。');
  const info = await getLocalDownloadInfo(job);
  if (info.currentPath !== entry.currentPath) throw new Error('文件名称已在另一次操作中改变，请从下载任务重新操作。');
  return { entry, job, info };
}

function localRenameDetails(job, title, info) {
  return { jobId: job.id, title, filename: sanitizeFilename(title), currentPath: info.currentPath,
    directoryPath: info.directoryPath, directoryName: info.directoryName, currentFilename: info.currentFilename, size: info.size };
}

async function removeLocalRenameRequests(jobId) {
  const remaining = (await localRenameRequests()).filter(([, entry]) => entry.jobId !== jobId);
  await chrome.storage.session.set({ localRenameRequests: Object.fromEntries(remaining) });
}

function commitLocalRename(job, title, moved) {
  Object.assign(job, { title, localFilePath: moved.path, localFileSize: moved.size, updatedAt: Date.now() });
  if (moved.lastModified != null) job.localFileLastModified = moved.lastModified;
  else delete job.localFileLastModified;
  return { title: job.title, status: job.status, requiresLocalRename: false, localFileRenamed: true, localFilePath: moved.path, path: moved.path };
}

function requireOffscreen(sender) {
  if (sender.tab || sender.url !== OFFSCREEN_URL) throw new Error('无效的下载引擎请求。');
}

async function dispatch(message, sender) {
  await ready;
  if (sender.id !== chrome.runtime.id) throw new Error('无效的请求来源。');
  if (message.type === 'JOB_DIAGNOSTIC') {
    requireOffscreen(sender);
    await diagnosticStore.upsert(message.jobId, message.report);
    return { ok: true };
  }
  if (message.type === 'DETECT_STREAMS') {
    if (!sender.tab || !Array.isArray(message.urls)) throw new Error('无效的视频检测消息。');
    const urls = message.urls.filter((url) => typeof url === 'string');
    const xUrls = urls.filter(isXMediaUrl);
    if (xUrls.length) await detectX(sender.tab.id, xUrls.map(url => ({ id: xMediaKey(url), url, format: videoFormat(url), postId: getXPostId(sender.url || sender.tab.url) })), { title: message.title });
    await detect(sender.tab.id, urls.filter(url => !isXMediaUrl(url)), message.title);
    return { ok: true };
  }
  if (message.type === 'DETECT_X_MEDIA' || message.type === 'DETECT_X_POST') {
    if (!sender.tab || !isXPageUrl(sender.url || sender.tab.url)) throw new Error('无效的 X 视频检测来源。');
    if (message.type === 'DETECT_X_MEDIA') {
      if (!Array.isArray(message.items)) throw new Error('无效的 X 视频数据');
      await detectX(sender.tab.id, message.items, { postUrl: sender.url || sender.tab.url, title: sender.tab.title });
    } else {
      if (!getXPostId(message.url)) throw new Error('无效的 X 帖子链接');
      await xPostMedia(message.url, sender.tab.id);
    }
    return { ok: true };
  }
  if (message.type === 'JOB_UPDATE') {
    requireOffscreen(sender);
    await mutate(() => {
      const job = state.jobs.find((entry) => entry.id === message.jobId);
      if (!job || TERMINAL.has(job.status)) return;
      const patch = message.patch || {};
      for (const key of ['status', 'progress', 'completedSegments', 'totalSegments', 'bytes', 'retryCount', 'error']) {
        if (key in patch) job[key] = patch[key];
      }
      job.updatedAt = Date.now();
    });
    return { ok: true };
  }
  if (message.type === 'SAVE_BLOB') {
    requireOffscreen(sender);
    const job = state.jobs.find((entry) => entry.id === message.jobId);
    if (!job || !ACTIVE.has(job.status)) throw new Error('下载任务已结束。');
    if (!isOwnDownloadBlob(message.url, chrome.runtime.id)) {
      throw new Error('无效的视频文件地址。');
    }
    await mutate(() => {
      if (!ACTIVE.has(job.status)) throw new Error('下载任务已结束。');
      job.status = 'saving'; job.progress = 99;
    });
    let anchorWait;
    let anchorDispatched = false;
    let anchorRejected = false;
    try {
      // Offscreen received a serialized job before any later inline rename.
      const filename = sanitizeFilename(job.title || 'video');
      if (job.saveAs === false) {
        await downloadNames.register(message.url, filename, job.id);
        if (!ACTIVE.has(job.status)) throw new Error('下载任务已结束。');
        anchorWait = waitForAnchor(message.url, job.id);
        anchorDispatched = true;
        const acknowledgement = offscreenMessage({ type: 'SAVE_WITH_ANCHOR', jobId: job.id, url: message.url, filename }).then(result => {
          if (!result?.ok) {
            anchorRejected = true;
            throw new Error(result?.error || '文件保存未启动，请重新下载。');
          }
          return anchorWait.promise;
        });
        // The timeout also applies if a closing offscreen document never acknowledges.
        const downloadId = await Promise.race([anchorWait.promise, acknowledgement]);
        return { ok: true, downloadId };
      }
      const downloadId = await chrome.downloads.download({
        url: message.url, filename,
        saveAs: job.saveAs, conflictAction: 'uniquify'
      });
      await mutate(() => { job.downloadId = downloadId; });
      if (job.status === 'cancelled') {
        await chrome.downloads.cancel(downloadId).catch(() => {});
        await releaseBlob(job.id);
      } else {
        // The browser may complete a small Blob before download() resolves.
        const [download] = await chrome.downloads.search({ id: downloadId });
        if (download) await reconcileDownload(downloadId, download.state, download.error);
      }
      return { ok: true, downloadId };
    } catch (error) {
      anchorWait?.finish(error);
      // A dispatched anchor can produce onCreated after cancellation or timeout.
      // Keep its bounded registration until that late event can be cancelled.
      if (!anchorDispatched || anchorRejected) await downloadNames.remove(message.url).catch(() => {});
      await mutate(() => {
        if (!TERMINAL.has(job.status)) Object.assign(job, { status: 'error', error: `保存失败：${error.message}` });
      });
      await releaseBlob(job.id);
      throw error;
    }
  }

  requirePopup(sender);
  switch (message.type) {
    case 'RENAME_STREAM': {
      const title = safeTitle(message.title, true);
      const stream = await mutate(() => {
        const current = findStream(message.tabId, message.streamId);
        current.customTitle = title;
        return { ...current };
      });
      return { ok: true, stream, title: getStreamTitle(stream) };
    }
    case 'GET_PAGE_TITLE':
      return { ok: true, title: await readPageTitle(message.tabId) };
    case 'USE_PAGE_TITLE': {
      await mutations;
      findStream(message.tabId, message.streamId);
      const version = streamVersion(message.tabId);
      const title = await readPageTitle(message.tabId);
      const stream = await mutate(() => {
        if (version !== streamVersion(message.tabId)) throw new Error('视频源已被清除，请重新检测。');
        const current = findStream(message.tabId, message.streamId);
        current.customTitle = title;
        return { ...current };
      });
      return { ok: true, stream, title };
    }
    case 'GET_DIAGNOSTICS':
      return { ok: true, reports: await diagnosticStore.list() };
    case 'GET_DIAGNOSTIC':
      return { ok: true, report: await diagnosticStore.get(message.jobId) };
    case 'CLEAR_DIAGNOSTICS':
      await diagnosticStore.clear();
      return { ok: true };
    case 'OPEN_PREVIEW': {
      const source = await requestedSource(message);
      const id = crypto.randomUUID();
      await mutate(async () => {
        const stored = await chrome.storage.session.get('previewSources');
        const entries = Object.entries(stored.previewSources || {}).slice(-19);
        const previewSources = Object.fromEntries(entries);
        previewSources[id] = { url: source.url, format: source.format, platform: source.platform, postUrl: source.postUrl, streamId: source.streamId,
          ...(Object.hasOwn(source, 'customTitle') ? { customTitle: source.customTitle } : {}),
          title: typeof source.title === 'string' ? source.title.slice(0, 200) : '视频预览', tabId: message.tabId, createdAt: Date.now() };
        await chrome.storage.session.set({ previewSources });
      });
      await chrome.tabs.create({ url: `${PREVIEW_URL}?id=${id}` });
      return { ok: true };
    }
    case 'GET_STATE':
      await mutations;
      if (Number.isInteger(message.tabId) && message.tabId >= 0 && !suppressedStreamLookups.has(message.tabId) && !(state.streamsByTab[message.tabId]?.length)) {
        try {
          const tab = await chrome.tabs.get(message.tabId);
          if (getXPostId(tab.url)) await xPostMedia(tab.url, message.tabId);
        } catch { /* Page metadata observation can still detect videos after login. */ }
      }
      return { ok: true, streams: state.streamsByTab[message.tabId] || [], jobs: state.jobs, settings: state.settings };
    case 'START_DOWNLOAD': {
      const source = await requestedSource(message, { requireTitle: true });
      const job = {
        id: crypto.randomUUID(), url: source.url, format: source.format, platform: source.platform, postUrl: source.postUrl, title: String(source.title).slice(0, 200),
        tabId: message.tabId, quality: message.quality || 'best',
        saveAs: typeof message.saveAs === 'boolean' ? message.saveAs : state.settings.saveAs,
        status: 'queued', progress: 0, completedSegments: 0, totalSegments: 0, bytes: 0,
        createdAt: Date.now()
      };
      const duplicateId = await mutate(() => {
        const duplicate = state.jobs.find(entry => entry.url === source.url && entry.tabId === message.tabId && entry.title === job.title && ACTIVE.has(entry.status));
        if (duplicate) return duplicate.id;
        state.jobs.unshift(job);
        return null;
      });
      if (duplicateId) return { ok: true, jobId: duplicateId };
      try {
        await ensureOffscreen();
        if (job.status === 'cancelled') return { ok: true, jobId: job.id };
        const result = await offscreenMessage({ type: 'RUN_JOB', job, settings: state.settings, extensionVersion: chrome.runtime.getManifest?.()?.version || '' });
        if (!result?.ok) throw new Error(result?.error || '下载引擎未响应，请重试。');
      } catch (error) {
        await mutate(() => { if (job.status !== 'cancelled') Object.assign(job, { status: 'error', error: error.message }); });
        throw error;
      }
      return { ok: true, jobId: job.id };
    }
    case 'RESOLVE_X_POST':
      return { ok: true, streams: await xPostMedia(message.url, message.tabId) };
    case 'RENAME_JOB': {
      const title = safeTitle(message.title, false, '任务名称');
      const renamed = await mutate(async () => {
        const job = state.jobs.find(entry => entry.id === message.jobId);
        if (!job) throw new Error('下载任务不存在或已被删除。');
        if (job.status === 'saving') throw new Error('文件正在保存，暂时无法修改名称。');
        if (job.status === 'complete') {
          try {
            const moved = await renameLocalDownload(job, title);
            const committed = commitLocalRename(job, title, moved);
            await removeLocalRenameRequests(job.id).catch(() => {});
            return committed;
          } catch (error) {
            if (error?.code !== 'LOCAL_DIRECTORY_AUTHORIZATION_REQUIRED') throw error;
            const info = await getLocalDownloadInfo(job);
            const id = crypto.randomUUID();
            const remaining = (await localRenameRequests()).filter(([, entry]) => entry.jobId !== job.id).slice(-19);
            const requests = Object.fromEntries(remaining);
            requests[id] = { jobId: job.id, title, currentPath: info.currentPath, createdAt: Date.now() };
            await chrome.storage.session.set({ localRenameRequests: requests });
            return { title: job.title, status: job.status, requiresLocalRename: true, localFileRenamed: false, authorizationRequired: true,
              authorizationId: id, authorization: localRenameDetails(job, title, info) };
          }
        }
        job.title = title;
        job.updatedAt = Date.now();
        return { title: job.title, status: job.status, requiresLocalRename: false, localFileRenamed: false };
      });
      return { ok: true, ...renamed };
    }
    case 'GET_LOCAL_RENAME': {
      await mutations;
      const { entry, job, info } = await localRenameTicket(message.id);
      return { ok: true, ...localRenameDetails(job, entry.title, info) };
    }
    case 'COMPLETE_LOCAL_RENAME': {
      const result = await mutate(async () => {
        const { entry, job } = await localRenameTicket(message.id);
        const moved = await renameLocalDownload(job, entry.title);
        const committed = commitLocalRename(job, entry.title, moved);
        await removeLocalRenameRequests(job.id).catch(() => {});
        return committed;
      });
      return { ok: true, ...result };
    }
    case 'CANCEL_JOB': {
      const job = await mutate(() => {
        const current = state.jobs.find(entry => entry.id === message.jobId);
        return cancelJobState(current) ? current : null;
      });
      if (job) await stopCancelledJob(job);
      return { ok: true };
    }
    case 'DELETE_JOB': {
      const cancelled = await mutate(() => {
        const index = state.jobs.findIndex(entry => entry.id === message.jobId);
        if (index < 0) return null;
        const [job] = state.jobs.splice(index, 1);
        return cancelJobState(job) ? job : null;
      });
      if (cancelled) await stopCancelledJob(cancelled);
      return { ok: true };
    }
    case 'CLEAR_JOBS': {
      const cancelled = await mutate(() => {
        const snapshot = state.jobs;
        state.jobs = [];
        return snapshot.filter(cancelJobState);
      });
      await Promise.all(cancelled.map(stopCancelledJob));
      return { ok: true };
    }
    case 'CLEAR_STREAMS':
      await mutate(() => { suppressedStreamLookups.add(message.tabId); clearTabStreams(message.tabId); });
      await updateBadge(message.tabId);
      return { ok: true };
    case 'RESCAN': {
      if (!Number.isInteger(message.tabId) || message.tabId < 0) throw new Error('请先打开视频网页。');
      await mutate(() => { suppressedStreamLookups.delete(message.tabId); });
      try { await chrome.tabs.sendMessage(message.tabId, { type: 'SCAN_STREAMS' }); }
      catch {
        try { await chrome.scripting.executeScript({ target: { tabId: message.tabId, allFrames: true }, files: ['content.js'] }); }
        catch { throw new Error('此页面无法检测，请在普通网页中播放视频后重试。'); }
      }
      const tab = await chrome.tabs.get(message.tabId);
      if (getXPostId(tab.url)) {
        await chrome.scripting.executeScript({ target: { tabId: message.tabId }, world: 'MAIN', files: ['x-observer.js'] }).catch(() => {});
        try { await xPostMedia(tab.url, message.tabId); }
        catch (error) { if (!(state.streamsByTab[message.tabId] || []).length) throw error; }
      }
      return { ok: true };
    }
    case 'OPEN_DOWNLOAD':
      if (!Number.isInteger(message.downloadId)) throw new Error('无效的下载记录。');
      await mutations;
      if (state.jobs.some(job => job.downloadId === message.downloadId && job.localFilePath)) throw new Error('文件已在本地改名，Chrome 下载记录中的旧路径无法定位新文件；请打开文件所在文件夹。');
      await chrome.downloads.show(message.downloadId);
      return { ok: true };
    case 'SAVE_SETTINGS':
      await mutate(async () => {
        if (typeof message.settings?.saveAs === 'boolean') state.settings.saveAs = message.settings.saveAs;
        if (Number.isInteger(message.settings?.concurrency)) state.settings.concurrency = Math.max(1, Math.min(8, message.settings.concurrency));
        if (Number.isInteger(message.settings?.retries)) state.settings.retries = Math.max(0, Math.min(10, message.settings.retries));
        await chrome.storage.local.set({ settings: state.settings });
      });
      return { ok: true, settings: state.settings };
    default:
      throw new Error('未知操作。');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background') return;
  dispatch(message, sender).then(sendResponse, (error) => sendResponse({ ok: false, error: error.message || String(error) }));
  return true;
});

