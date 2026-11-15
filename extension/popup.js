import { getStreamTitle } from './lib/stream-names.js';
import { restoreLocalDownloadPermission, saveDirectory } from './lib/local-downloads.js';

const $ = (id) => document.getElementById(id);
const activeStatuses = new Set(['queued', 'preparing', 'downloading', 'converting', 'saving']);
const statusLabels = { queued: '等待下载', preparing: '解析视频', downloading: '下载中', converting: '合并 MP4', saving: '正在保存', complete: '已完成', error: '下载失败', cancelled: '已取消' };
let tabId = null;
let pageTitle = '';
let onXPage = false;
let refreshing = false;
let refreshAgain = false;
let settingsLoaded = false;
let refreshTimer;
let noticeTimer;
let currentState = { streams: [], jobs: [], settings: {} };
let renderedStreams = '';
let renderedJobs = '';
const diagnosticExports = new Map();
const removingJobIds = new Set();
let clearingJobs = false;
const jobTitleEditors = new Map();
let renderingJobCards = false;
const localRenamePrompts = new Map();
const authorizingJobIds = new Set();
const streamTitleEditors = new Map();
const streamActionIds = new Set();
const streamPageTitleIds = new Set();
let renderingStreamCards = false;
let clearingStreams = false;
let rescanningStreams = false;

async function request(type, data = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (!response?.ok) throw new Error(response?.error || '插件暂时未响应，请重新打开插件。');
  return response;
}

function notice(message, isError = false) {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').classList.toggle('is-error', isError);
  $('notice').hidden = !message;
  if (!isError && message) noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6500);
}

function switchView(view) {
  for (const name of ['streams', 'jobs']) {
    const selected = name === view;
    $(`${name}-tab`).classList.toggle('is-active', selected);
    $(`${name}-tab`).setAttribute('aria-pressed', String(selected));
    $(`${name}-panel`).hidden = !selected;
  }
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function mediaIcon() {
  const wrapper = element('span', 'media-icon');
  wrapper.setAttribute('aria-hidden', 'true');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '19');
  svg.setAttribute('height', '19');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M8 5.5v13L18 12 8 5.5Z');
  path.setAttribute('fill', 'currentColor');
  svg.append(path);
  wrapper.append(svg);
  return wrapper;
}

function shortUrl(value) {
  try {
    const url = new URL(value);
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { path = url.pathname; }
    return `${url.hostname}${path}`;
  } catch { return value || ''; }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isXHost(hostname) {
  return /(^|\.)(?:x|twitter)\.com$/i.test(hostname);
}

function isXPostUrl(value) {
  try {
    const url = new URL(value);
    return isXHost(url.hostname) && /\/status\/\d+(?:\/|$)/.test(url.pathname);
  } catch { return false; }
}

function streamFormat(stream) {
  if (stream.format === 'mp4' || /\.mp4(?:$|[?&#/])/i.test(stream.url || '')) return 'MP4';
  return 'HLS';
}

async function withButton(button, action) {
  button.disabled = true;
  try { await action(); } catch (error) { notice(error.message || String(error), true); }
  finally { button.disabled = false; }
}

function releaseDiagnosticExport(entry) {
  if (entry.released) return;
  entry.released = true;
  clearTimeout(entry.timer);
  URL.revokeObjectURL(entry.url);
  if (entry.downloadId != null) diagnosticExports.delete(entry.downloadId);
}

function diagnosticFilename() {
  const now = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `liuguang-diagnostics-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;
}

async function exportDiagnostics(jobId) {
  try {
    const result = await request(jobId ? 'GET_DIAGNOSTIC' : 'GET_DIAGNOSTICS', jobId ? { jobId } : {});
    const reports = jobId ? (result.report ? [result.report] : []) : (Array.isArray(result.reports) ? result.reports : []);
    if (!reports.length) {
      notice(jobId ? '此任务暂无诊断日志，请重新下载后再试。' : '暂无诊断日志，发起下载后可再次导出。');
      return;
    }
    // Only the dedicated, sanitized reports API is exported. Download state
    // contains source URLs/titles and must never be included in this file.
    const entry = {
      url: URL.createObjectURL(new Blob([JSON.stringify({ reports }, null, 2)], { type: 'application/json;charset=utf-8' })),
      downloadId: null, timer: null, released: false
    };
    entry.timer = setTimeout(() => releaseDiagnosticExport(entry), 5 * 60 * 1000);
    try {
      const filename = diagnosticFilename();
      entry.downloadId = await chrome.downloads.download({ url: entry.url, filename, saveAs: true, conflictAction: 'uniquify' });
      if (!entry.released) diagnosticExports.set(entry.downloadId, entry);
      // A small JSON file can finish before download() resolves and its event
      // arrives before the ID is registered above. Reconcile that case too.
      const [download] = await chrome.downloads.search({ id: entry.downloadId }).catch(() => []);
      if (download?.state === 'complete' || download?.state === 'interrupted') releaseDiagnosticExport(entry);
      if (download?.state === 'interrupted') throw new Error('文件保存未完成，请重新导出。');
      notice('诊断日志已生成，请留意 Chrome 下载记录。');
    } catch (error) {
      releaseDiagnosticExport(entry);
      throw error;
    }
  } catch (error) {
    throw new Error(`诊断日志导出失败：${error?.message || String(error)}`);
  }
}

chrome.downloads.onChanged.addListener(delta => {
  const entry = diagnosticExports.get(delta.id);
  if (!entry || !['complete', 'interrupted'].includes(delta.state?.current)) return;
  releaseDiagnosticExport(entry);
  if (delta.state.current === 'interrupted') notice('诊断日志保存未完成，请重新导出。', true);
});

async function startDownload(url, title, streamId) {
  await request('START_DOWNLOAD', { tabId, streamId, url, title: streamId ? title : title || (isXPostUrl(url) ? undefined : pageTitle || '视频'), quality: 'best', saveAs: !$('auto-save').checked });
  notice('任务已添加，完成后将保存为 MP4。');
  switchView('jobs');
  await refresh();
}

async function openPreview(url, title, streamId) {
  await request('OPEN_PREVIEW', { tabId, streamId, url, title: streamId ? title : title || (isXPostUrl(url) ? undefined : pageTitle || '视频预览') });
}

function manualUrl() {
  let url;
  try { url = new URL($('manual-url').value.trim()); } catch { throw new Error('请输入完整的 M3U8、MP4 或 X 帖子链接。'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('链接需以 https:// 或 http:// 开头。');
  if (url.username || url.password) throw new Error('请使用不含用户名和密码的视频链接。');
  if (isXHost(url.hostname) && !isXPostUrl(url.href)) throw new Error('请粘贴包含 /status/数字 的 X 帖子链接。');
  return url.href;
}

function createStreamCard(stream) {
    const card = element('article', 'card stream-card');
    card.dataset.streamId = stream.id;
    const top = element('div', 'stream-top');
    const content = element('div', 'stream-content');
    const name = getStreamTitle(stream);
    const title = element('h3', 'card-title stream-title-slot');
    const titleButton = element('button', `stream-title-button${name ? '' : ' is-unnamed'}`, name || '未命名视频');
    titleButton.type = 'button';
    titleButton.dataset.renameStreamId = stream.id;
    titleButton.title = name ? `${name} · 点击修改名称` : '点击输入视频名称';
    titleButton.setAttribute('aria-label', name ? `修改视频名称：${name}` : '为未命名视频设置名称');
    titleButton.addEventListener('pointerdown', event => {
      if (streamTitleEditors.size) event.preventDefault();
    });
    titleButton.addEventListener('click', () => beginStreamTitleEdit(stream.id));
    title.append(titleButton);
    const sourceRow = element('div', 'stream-source-row');
    const source = element('p', 'card-source', stream.postUrl ? `帖子 · ${shortUrl(stream.postUrl)}` : shortUrl(stream.url));
    source.title = stream.postUrl || stream.url;
    const usePageTitle = element('button', 'text-button stream-use-page-title', '使用网页标题');
    usePageTitle.type = 'button';
    usePageTitle.dataset.streamId = stream.id;
    usePageTitle.title = '读取当前网页的 document.title 作为视频名称';
    usePageTitle.addEventListener('pointerdown', event => {
      if (streamTitleEditors.has(stream.id)) event.preventDefault();
    });
    usePageTitle.addEventListener('click', () => useStreamPageTitle(stream.id));
    sourceRow.append(source, usePageTitle);
    content.append(title, sourceRow);
    top.append(mediaIcon(), content);
    const bottom = element('div', 'stream-bottom');
    const tags = element('div', 'tags');
    if (stream.platform === 'x' || isXPostUrl(stream.postUrl)) tags.append(element('span', 'tag x-video', 'X 视频'));
    const format = streamFormat(stream);
    tags.append(element('span', `tag ${format.toLowerCase()}`, format), element('span', 'tag', '自动最高画质'));
    const matching = currentState.jobs.some(job => job.url === stream.url && job.tabId === tabId && job.title === name && activeStatuses.has(job.status));
    const button = element('button', 'primary-button', matching ? '正在处理' : '下载 MP4 ↓');
    button.type = 'button';
    button.dataset.downloadStreamId = stream.id;
    button.disabled = matching;
    button.addEventListener('pointerdown', event => {
      if (streamTitleEditors.has(stream.id)) event.preventDefault();
    });
    button.addEventListener('click', () => actOnStream(stream.id, 'download'));
    const preview = element('button', 'secondary-button', '预览');
    preview.type = 'button';
    preview.dataset.previewStreamId = stream.id;
    preview.addEventListener('pointerdown', event => {
      if (streamTitleEditors.has(stream.id)) event.preventDefault();
    });
    preview.addEventListener('click', () => actOnStream(stream.id, 'preview'));
    const actions = element('div', 'stream-actions');
    actions.append(preview, button);
    bottom.append(tags, actions);
    card.append(top, bottom);
    return card;
}

function renderStreams(streams) {
  const list = $('streams-list');
  const existingCards = new Map(Array.from(list.children, card => [card.dataset.streamId, card]));
  const focusedInput = document.activeElement?.matches('.stream-title-input') ? document.activeElement : null;
  const selection = focusedInput ? [focusedInput.selectionStart, focusedInput.selectionEnd, focusedInput.selectionDirection] : null;
  const cards = [];
  renderingStreamCards = true;
  try {
    for (const stream of streams) {
      let card = existingCards.get(stream.id);
      const updated = createStreamCard(stream);
      if (streamTitleEditors.has(stream.id) && card) {
        const source = card.querySelector('.card-source');
        const updatedSource = updated.querySelector('.card-source');
        source.textContent = updatedSource.textContent;
        source.title = updatedSource.title;
        card.querySelector('.stream-bottom').replaceWith(updated.querySelector('.stream-bottom'));
      } else card = updated;
      cards.push(card);
    }
    const kept = new Set(cards);
    cards.forEach((card, index) => {
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    });
    for (const card of Array.from(list.children)) if (!kept.has(card)) card.remove();
    for (const streamId of streamTitleEditors.keys()) {
      if (!streams.some(stream => stream.id === streamId)) streamTitleEditors.delete(streamId);
    }
  } finally { renderingStreamCards = false; }
  if (focusedInput?.isConnected && document.activeElement !== focusedInput) {
    focusedInput.focus({ preventScroll: true });
    focusedInput.setSelectionRange(...selection);
  }
  $('streams-empty').hidden = streams.length > 0;
  $('streams-count').textContent = String(streams.length);
  $('detected-count').textContent = `${streams.length} 个视频源`;
  updateStreamActionButtons();
}

function updateStreamActionButtons() {
  const pending = Array.from(streamTitleEditors.values()).some(editor => editor.pending);
  const busy = clearingStreams || rescanningStreams;
  $('clear-streams').disabled = busy || pending || streamActionIds.size > 0 || streamPageTitleIds.size > 0 || currentState.streams.length === 0;
  $('rescan').disabled = busy || pending || streamActionIds.size > 0 || streamPageTitleIds.size > 0;
  for (const card of $('streams-list').children) {
    const streamId = card.dataset.streamId;
    const stream = currentState.streams.find(item => item.id === streamId);
    const acting = streamActionIds.has(streamId);
    const pageNaming = streamPageTitleIds.has(streamId);
    const saving = streamTitleEditors.get(streamId)?.pending === true;
    const titleButton = card.querySelector('.stream-title-button');
    if (titleButton) titleButton.disabled = busy || acting || pageNaming;
    card.querySelector('.stream-use-page-title').disabled = busy || acting || pageNaming || saving;
    const matching = currentState.jobs.some(job => job.url === stream?.url && job.tabId === tabId && job.title === getStreamTitle(stream) && activeStatuses.has(job.status));
    card.querySelector('[data-download-stream-id]').disabled = busy || acting || pageNaming || matching;
    card.querySelector('[data-preview-stream-id]').disabled = busy || acting || pageNaming;
  }
}

function beginStreamTitleEdit(streamId) {
  const stream = currentState.streams.find(item => item.id === streamId);
  if (!stream || clearingStreams || rescanningStreams || streamActionIds.has(streamId) || streamPageTitleIds.has(streamId)) return;
  const existing = streamTitleEditors.get(streamId);
  if (existing) { if (!existing.pending) existing.input.focus({ preventScroll: true }); return; }
  const card = Array.from($('streams-list').children).find(item => item.dataset.streamId === streamId);
  if (!card) return;
  const input = element('input', 'stream-title-input');
  input.type = 'text';
  input.value = getStreamTitle(stream);
  input.placeholder = '输入视频名称';
  input.maxLength = 200;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.renameStreamId = streamId;
  input.setAttribute('aria-label', '视频名称');
  input.title = 'Enter 保存，Esc 取消；也可清空名称';
  const editor = { input, originalTitle: input.value, pending: false, promise: null };
  streamTitleEditors.set(streamId, editor);
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      editor.restoreFocus = true;
      saveStreamTitle(streamId).catch(error => notice(error.message || String(error), true));
    } else if (event.key === 'Escape') { event.preventDefault(); cancelStreamTitleEdit(streamId, true); }
  });
  input.addEventListener('blur', () => {
    if (!renderingStreamCards) saveStreamTitle(streamId).catch(error => notice(error.message || String(error), true));
  });
  card.querySelector('.stream-title-slot').replaceChildren(input);
  input.focus({ preventScroll: true });
  input.select();
}

function cancelStreamTitleEdit(streamId, restoreFocus = false) {
  const editor = streamTitleEditors.get(streamId);
  if (!editor || editor.pending) return;
  streamTitleEditors.delete(streamId);
  renderStreams(currentState.streams);
  if (restoreFocus) {
    const card = Array.from($('streams-list').children).find(item => item.dataset.streamId === streamId);
    card?.querySelector('.stream-title-button')?.focus({ preventScroll: true });
  }
}

function applyStreamUpdate(stream) {
  const index = currentState.streams.findIndex(item => item.id === stream?.id);
  if (index >= 0) currentState.streams[index] = { ...currentState.streams[index], ...stream };
  renderedStreams = '';
  renderStreams(currentState.streams);
  return index >= 0 ? currentState.streams[index] : null;
}

async function saveStreamTitle(streamId, quiet = false) {
  const editor = streamTitleEditors.get(streamId);
  if (!editor) return currentState.streams.find(item => item.id === streamId);
  if (editor.promise) return editor.promise;
  if (editor.pending) return null;
  const title = editor.input.value.trim();
  if (title === editor.originalTitle) {
    cancelStreamTitleEdit(streamId);
    return currentState.streams.find(item => item.id === streamId);
  }
  editor.pending = true;
  editor.input.disabled = true;
  editor.input.setAttribute('aria-busy', 'true');
  updateStreamActionButtons();
  editor.promise = Promise.resolve().then(async () => {
    try {
      const result = await request('RENAME_STREAM', { tabId, streamId, title });
      streamTitleEditors.delete(streamId);
      const updated = applyStreamUpdate(result.stream);
      if (editor.restoreFocus && !streamActionIds.has(streamId)) {
        const card = Array.from($('streams-list').children).find(item => item.dataset.streamId === streamId);
        card?.querySelector('.stream-title-button')?.focus({ preventScroll: true });
      }
      if (!quiet) notice(getStreamTitle(updated || result.stream) ? '视频名称已更新，下载时将使用此名称。' : '已清空名称，可手动填写或选择使用网页标题。');
      return updated || result.stream;
    } catch (error) {
      editor.pending = false;
      editor.promise = null;
      editor.input.disabled = false;
      editor.input.removeAttribute('aria-busy');
      if (editor.restoreFocus && editor.input.isConnected) editor.input.focus({ preventScroll: true });
      throw error;
    } finally { updateStreamActionButtons(); }
  });
  return editor.promise;
}

async function useStreamPageTitle(streamId) {
  if (clearingStreams || rescanningStreams || streamActionIds.has(streamId) || streamPageTitleIds.has(streamId) || streamTitleEditors.get(streamId)?.pending) return;
  cancelStreamTitleEdit(streamId);
  streamPageTitleIds.add(streamId);
  updateStreamActionButtons();
  try {
    const result = await request('USE_PAGE_TITLE', { tabId, streamId });
    const updated = applyStreamUpdate(result.stream);
    notice(getStreamTitle(updated || result.stream) ? '已使用当前网页标题作为视频名称。' : '当前网页没有可用标题，请手动输入视频名称。');
  } catch (error) { notice(error.message || String(error), true); }
  finally { streamPageTitleIds.delete(streamId); updateStreamActionButtons(); }
}

async function actOnStream(streamId, action) {
  if (clearingStreams || rescanningStreams || streamActionIds.has(streamId) || streamPageTitleIds.has(streamId)) return;
  streamActionIds.add(streamId);
  updateStreamActionButtons();
  let needsName = false;
  try {
    const saved = await saveStreamTitle(streamId, true);
    if (saved) applyStreamUpdate(saved);
    const stream = currentState.streams.find(item => item.id === streamId);
    if (!stream) throw new Error('此视频源已被移除，请重新检测。');
    const title = getStreamTitle(stream);
    if (action === 'download' && !title) {
      needsName = true;
      notice('请先填写视频名称，或选择“使用网页标题”。');
    } else if (action === 'download') await startDownload(stream.url, title, streamId);
    else await openPreview(stream.url, title, streamId);
  } catch (error) { notice(error.message || String(error), true); }
  finally {
    streamActionIds.delete(streamId);
    updateStreamActionButtons();
    if (needsName) beginStreamTitleEdit(streamId);
  }
}

async function rescanStreams() {
  if (clearingStreams || rescanningStreams || streamActionIds.size || streamPageTitleIds.size || Array.from(streamTitleEditors.values()).some(editor => editor.pending)) return;
  rescanningStreams = true;
  updateStreamActionButtons();
  try {
    if (!Number.isInteger(tabId)) throw new Error('请先打开一个普通网页。');
    await request('RESCAN', { tabId });
    await refresh();
    notice(onXPage ? '已重新扫描 X 页面。请播放帖子视频，或刷新页面后重试。' : '已重新扫描。若尚未发现视频，请在页面播放视频或刷新后重试。');
  } catch (error) { notice(error.message || String(error), true); }
  finally { rescanningStreams = false; updateStreamActionButtons(); }
}

async function clearStreams() {
  if (clearingStreams || rescanningStreams || streamActionIds.size || streamPageTitleIds.size || Array.from(streamTitleEditors.values()).some(editor => editor.pending) || !currentState.streams.length) return;
  for (const streamId of streamTitleEditors.keys()) cancelStreamTitleEdit(streamId);
  clearingStreams = true;
  updateStreamActionButtons();
  try {
    await request('CLEAR_STREAMS', { tabId });
    await refresh();
  } catch (error) { notice(error.message || String(error), true); }
  finally { clearingStreams = false; updateStreamActionButtons(); }
}

function createJobCard(job) {
    const card = element('article', 'card job-card');
    card.dataset.jobId = job.id;
    const remove = element('button', 'job-remove-button', '×');
    remove.type = 'button';
    remove.dataset.removeJobId = job.id;
    remove.setAttribute('aria-label', `${activeStatuses.has(job.status) ? '取消并移除' : '移除'}任务：${job.title || '视频'}`);
    remove.title = activeStatuses.has(job.status) ? '取消下载并移除此任务；已保存的文件不会删除' : '移除此任务记录；已保存的文件不会删除';
    remove.addEventListener('pointerdown', event => {
      if (jobTitleEditors.has(job.id)) event.preventDefault();
    });
    remove.addEventListener('click', () => removeJob(job.id));
    const top = element('div', 'job-top');
    const content = element('div', 'job-content');
    const title = element('h3', 'card-title job-title-slot');
    const titleButton = element('button', 'job-title-button', job.title || '视频');
    titleButton.type = 'button';
    titleButton.dataset.renameJobId = job.id;
    titleButton.disabled = job.status === 'saving';
    titleButton.title = job.status === 'saving' ? '正在保存，完成后可修改名称' : `${job.title || '视频'} · 点击修改${job.status === 'complete' ? '本地文件名；首次需要授权文件夹' : '名称'}`;
    titleButton.setAttribute('aria-label', `修改任务名称：${job.title || '视频'}`);
    titleButton.addEventListener('click', () => beginJobTitleEdit(job.id));
    title.append(titleButton);
    const source = element('p', 'card-source', shortUrl(job.url));
    content.append(title, source);
    const status = element('span', `job-state ${job.status || ''}`, statusLabels[job.status] || '处理中');
    top.append(mediaIcon(), content, status);
    card.append(remove, top);
    if (activeStatuses.has(job.status) || job.status === 'complete') {
      const progress = job.status === 'complete' ? 100 : Math.max(0, Math.min(100, Number(job.progress) || 0));
      const track = element('div', 'progress-track');
      track.setAttribute('role', 'progressbar');
      track.setAttribute('aria-label', `${job.title || '视频'}下载进度`);
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.round(progress)));
      const fill = element('div', 'progress-fill');
      fill.style.width = `${progress}%`;
      track.append(fill);
      card.append(track);
    }
    const meta = element('div', 'job-meta');
    if (job.status === 'downloading' && job.format === 'mp4') meta.append(element('span', '', '正在下载 MP4 文件…'));
    else if (job.status === 'downloading' && job.totalSegments) meta.append(element('span', '', `${job.completedSegments || 0} / ${job.totalSegments} 片段`));
    else if (job.status === 'converting') meta.append(element('span', '', '正在将音视频合并为 MP4…'));
    else if (job.status === 'preparing') meta.append(element('span', '', '正在读取视频信息…'));
    else if (job.status === 'saving') meta.append(element('span', '', job.saveAs === false ? '正在按 Chrome 下载设置保存…' : '请留意 Chrome 保存对话框'));
    else if (job.status === 'complete') meta.append(element('span', '', 'MP4 已保存'));
    const bytes = formatBytes(job.bytes);
    if (bytes) meta.append(element('span', '', bytes));
    if (job.retryCount > 0) meta.append(element('span', '', `已重试 ${job.retryCount} 次`));
    if (activeStatuses.has(job.status)) {
      const cancel = element('button', 'text-button muted', '取消');
      cancel.type = 'button';
      cancel.addEventListener('click', () => withButton(cancel, async () => {
        await request('CANCEL_JOB', { jobId: job.id });
        await refresh();
      }));
      meta.append(cancel);
    } else if (job.status === 'complete' && Number.isInteger(job.downloadId) && !job.localFilePath) {
      const show = element('button', 'text-button', '在文件夹中显示 ↗');
      show.type = 'button';
      show.addEventListener('click', () => withButton(show, () => request('OPEN_DOWNLOAD', { downloadId: job.downloadId })));
      meta.append(show);
    } else if (job.status === 'error' || job.status === 'cancelled') {
      const retry = element('button', 'text-button', '重新下载');
      retry.type = 'button';
      retry.addEventListener('click', () => withButton(retry, () => startDownload(job.url, job.title)));
      meta.append(retry);
    }
    if (meta.childNodes.length) card.append(meta);
    if (job.localFilePath) {
      const localFile = element('p', 'job-local-file', `本地文件：${job.localFilePath.split(/[\\/]/).pop()}`);
      localFile.title = job.localFilePath;
      card.append(localFile);
    }
    const authorization = localRenamePrompts.get(job.id);
    if (authorization && job.status === 'complete') {
      const prompt = element('div', 'local-rename-prompt');
      prompt.append(element('p', 'local-rename-new-name', `新文件名：${authorization.filename}`));
      prompt.append(element('p', 'local-rename-directory', `请选择文件夹：${authorization.directoryPath}`));
      const choose = element('button', 'secondary-button', authorizingJobIds.has(job.id) ? '正在授权…' : '选择文件夹并改名');
      choose.type = 'button';
      choose.dataset.authorizeJobId = job.id;
      choose.disabled = authorizingJobIds.has(job.id);
      choose.addEventListener('pointerdown', event => event.preventDefault());
      choose.addEventListener('click', () => authorizeJobDirectory(job.id));
      prompt.append(choose);
      if (authorization.error) prompt.append(element('p', 'job-error', authorization.error));
      card.append(prompt);
    }
    if (job.error && job.status === 'error') card.append(element('p', 'job-error', job.error));
    if (job.status === 'error') {
      const actions = element('div', 'job-diagnostic-actions');
      const exportButton = element('button', 'text-button', '导出此任务日志');
      exportButton.type = 'button';
      exportButton.dataset.diagnosticJobId = job.id;
      exportButton.addEventListener('click', () => withButton(exportButton, () => exportDiagnostics(job.id)));
      actions.append(exportButton);
      card.append(actions);
    }
    return card;
}

function renderJobs(jobs) {
  const list = $('jobs-list');
  const existingCards = new Map(Array.from(list.children, card => [card.dataset.jobId, card]));
  const focusedInput = document.activeElement?.matches('.job-title-input') ? document.activeElement : null;
  const selection = focusedInput ? [focusedInput.selectionStart, focusedInput.selectionEnd, focusedInput.selectionDirection] : null;
  const cards = [];
  renderingJobCards = true;
  try {
    for (const job of jobs) {
      const editor = jobTitleEditors.get(job.id);
      let card = existingCards.get(job.id);
      const updated = createJobCard(job);
      if (editor && card) {
        // Keep the input node mounted while progress and other task controls
        // change, so polling never commits or discards a draft.
        card.querySelector('.job-state').replaceWith(updated.querySelector('.job-state'));
        card.querySelector('.card-source').textContent = shortUrl(job.url);
        const remove = card.querySelector('.job-remove-button');
        const updatedRemove = updated.querySelector('.job-remove-button');
        remove.title = updatedRemove.title;
        remove.setAttribute('aria-label', updatedRemove.getAttribute('aria-label'));
        for (const child of Array.from(card.children)) {
          if (!child.matches('.job-top,.job-remove-button')) child.remove();
        }
        for (const child of Array.from(updated.children)) {
          if (!child.matches('.job-top,.job-remove-button')) card.append(child);
        }
        editor.input.readOnly = !editor.pending && job.status === 'saving';
        editor.input.title = job.status === 'saving' ? '正在保存，完成后可修改名称' : 'Enter 保存，Esc 取消';
      } else card = updated;
      cards.push(card);
    }
    const kept = new Set(cards);
    cards.forEach((card, index) => {
      if (list.children[index] !== card) list.insertBefore(card, list.children[index] || null);
    });
    for (const card of Array.from(list.children)) if (!kept.has(card)) card.remove();
    for (const jobId of jobTitleEditors.keys()) {
      if (!jobs.some(job => job.id === jobId)) jobTitleEditors.delete(jobId);
    }
    for (const jobId of localRenamePrompts.keys()) {
      if (!jobs.some(job => job.id === jobId)) localRenamePrompts.delete(jobId);
    }
  } finally { renderingJobCards = false; }
  if (focusedInput?.isConnected && document.activeElement !== focusedInput) {
    focusedInput.focus({ preventScroll: true });
    focusedInput.setSelectionRange(...selection);
  }
  $('jobs-empty').hidden = jobs.length > 0;
  const activeCount = jobs.filter((job) => activeStatuses.has(job.status)).length;
  $('jobs-count').textContent = String(activeCount || jobs.length);
  updateJobActionButtons();
}

function beginJobTitleEdit(jobId) {
  const job = currentState.jobs.find(item => item.id === jobId);
  if (!job || job.status === 'saving' || clearingJobs || removingJobIds.has(jobId) || authorizingJobIds.has(jobId) || jobTitleEditors.has(jobId)) return;
  localRenamePrompts.delete(jobId);
  const card = Array.from($('jobs-list').children).find(item => item.dataset.jobId === jobId);
  if (!card) return;
  card.querySelector('.local-rename-prompt')?.remove();
  const input = element('input', 'job-title-input');
  input.type = 'text';
  input.value = job.title || '视频';
  input.maxLength = 200;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.dataset.renameJobId = jobId;
  input.setAttribute('aria-label', '任务文件名');
  input.title = 'Enter 保存，Esc 取消';
  const editor = { input, originalTitle: input.value, pending: false };
  jobTitleEditors.set(jobId, editor);
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter') { event.preventDefault(); editor.restoreFocus = true; saveJobTitle(jobId); }
    else if (event.key === 'Escape') { event.preventDefault(); cancelJobTitleEdit(jobId, true); }
  });
  input.addEventListener('blur', () => { if (!renderingJobCards) saveJobTitle(jobId); });
  card.querySelector('.job-title-slot').replaceChildren(input);
  input.focus({ preventScroll: true });
  input.select();
}

function cancelJobTitleEdit(jobId, restoreFocus = false) {
  const editor = jobTitleEditors.get(jobId);
  if (!editor || editor.pending) return;
  jobTitleEditors.delete(jobId);
  renderJobs(currentState.jobs);
  if (restoreFocus) {
    const card = Array.from($('jobs-list').children).find(item => item.dataset.jobId === jobId);
    card?.querySelector('.job-title-button')?.focus({ preventScroll: true });
  }
}

async function saveJobTitle(jobId, { chooseDirectory = false } = {}) {
  const editor = jobTitleEditors.get(jobId);
  if (!editor || editor.pending) return;
  const job = currentState.jobs.find(item => item.id === jobId);
  if (!job) { cancelJobTitleEdit(jobId); return; }
  if (job.status === 'saving') {
    notice('任务正在保存，完成后可修改名称。');
    return;
  }
  const title = editor.input.value.trim();
  if (!title) {
    notice('文件名不能为空。', true);
    editor.input.focus({ preventScroll: true });
    return;
  }
  if (title === editor.originalTitle) { cancelJobTitleEdit(jobId); return; }
  editor.pending = true;
  editor.input.disabled = true;
  editor.input.setAttribute('aria-busy', 'true');
  updateJobActionButtons();
  try {
    if (job.status === 'complete' && !chooseDirectory) {
      // Stored handles outlive Chrome's temporary grant. Restore it from this
      // visible popup's user gesture before the worker performs the rename.
      const access = await restoreLocalDownloadPermission(job);
      if (access.available && !access.granted) {
        const error = new Error(access.requiresUserActivation
          ? '请在名称输入框按 Enter 确认改名，以恢复已保存的文件夹授权。'
          : '未获得文件夹读写权限，原文件名保持不变。');
        error.code = 'LOCAL_PERMISSION_NOT_GRANTED';
        error.requiresUserActivation = access.requiresUserActivation === true;
        throw error;
      }
    }
    const result = await request('RENAME_JOB', { jobId, title });
    if (result.authorizationRequired) {
      const authorization = result.authorization || await request('GET_LOCAL_RENAME', { id: result.authorizationId });
      localRenamePrompts.set(jobId, { ...authorization, id: result.authorizationId });
    } else localRenamePrompts.delete(jobId);
    const latest = currentState.jobs.find(item => item.id === jobId);
    if (latest) Object.assign(latest, result.job || { title: result.title || title });
    jobTitleEditors.delete(jobId);
    renderJobs(currentState.jobs);
    if (editor.restoreFocus) {
      const card = Array.from($('jobs-list').children).find(item => item.dataset.jobId === jobId);
      card?.querySelector('.job-title-button')?.focus({ preventScroll: true });
    }
    renderedJobs = '';
    await refresh();
    const status = result.job?.status || result.status || currentState.jobs.find(item => item.id === jobId)?.status || job.status;
    notice(result.authorizationRequired ? '请在任务卡片中选择文件所在文件夹，授权后完成改名。' : result.localFileRenamed ? '磁盘中的文件和任务名称均已修改。' : activeStatuses.has(status) ? '新名称将在保存时使用。' : '已更新任务名称，重新下载时将使用新名称。');
  } catch (error) {
    editor.pending = false;
    editor.input.disabled = false;
    editor.input.removeAttribute('aria-busy');
    if (editor.restoreFocus && editor.input.isConnected) editor.input.focus({ preventScroll: true });
    notice(error.message || String(error), true);
    if (['LOCAL_PERMISSION_NOT_GRANTED', 'LOCAL_PERMISSION_RESTORE_FAILED'].includes(error.code) && !error.requiresUserActivation) {
      const authorize = element('button', 'text-button', '重新授权文件夹');
      authorize.type = 'button';
      authorize.addEventListener('pointerdown', event => event.preventDefault());
      authorize.addEventListener('click', () => saveJobTitle(jobId, { chooseDirectory: true }));
      $('notice').append(' ', authorize);
    }
  } finally { updateJobActionButtons(); }
}

async function authorizeJobDirectory(jobId) {
  const authorization = localRenamePrompts.get(jobId);
  if (!authorization || clearingJobs || removingJobIds.has(jobId) || authorizingJobIds.has(jobId)) return;
  authorizingJobIds.add(jobId);
  authorization.error = '';
  updateJobActionButtons();
  try {
    if (typeof window.showDirectoryPicker !== 'function') throw new Error('当前浏览器不支持文件夹选择，请使用新版桌面 Chrome。');
    // The folder picker is invoked directly by this button's user gesture.
    const directory = await window.showDirectoryPicker({ id: 'liuguang-video-folder', mode: 'readwrite', startIn: 'downloads' });
    if (await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      if (!navigator.userActivation.isActive || await directory.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('未获得文件夹读写权限，原文件名保持不变。');
      }
    }
    await saveDirectory(authorization.directoryPath, directory);
    const result = await request('COMPLETE_LOCAL_RENAME', { id: authorization.id });
    const job = currentState.jobs.find(item => item.id === jobId);
    if (job) Object.assign(job, { title: result.title, localFilePath: result.localFilePath || result.path });
    localRenamePrompts.delete(jobId);
    renderedJobs = '';
    await refresh();
    renderJobs(currentState.jobs);
    notice('磁盘中的文件和任务名称均已修改。');
  } catch (error) {
    authorization.error = error?.name === 'AbortError' ? '已取消选择，原文件名保持不变。' : error.message || '文件夹授权失败，请重试。';
    renderJobs(currentState.jobs);
    notice(authorization.error, error?.name !== 'AbortError');
  } finally {
    authorizingJobIds.delete(jobId);
    updateJobActionButtons();
  }
}

function updateJobActionButtons() {
  const renaming = Array.from(jobTitleEditors.values()).some(editor => editor.pending);
  $('clear-jobs').disabled = clearingJobs || removingJobIds.size > 0 || renaming || authorizingJobIds.size > 0 || currentState.jobs.length === 0;
  for (const button of document.querySelectorAll('[data-remove-job-id]')) {
    button.disabled = clearingJobs || removingJobIds.has(button.dataset.removeJobId) || authorizingJobIds.has(button.dataset.removeJobId) || jobTitleEditors.get(button.dataset.removeJobId)?.pending === true;
  }
  for (const button of document.querySelectorAll('.job-title-button')) {
    const job = currentState.jobs.find(item => item.id === button.dataset.renameJobId);
    button.disabled = clearingJobs || removingJobIds.has(button.dataset.renameJobId) || authorizingJobIds.has(button.dataset.renameJobId) || job?.status === 'saving';
  }
  for (const button of document.querySelectorAll('[data-authorize-job-id]')) {
    const pending = authorizingJobIds.has(button.dataset.authorizeJobId);
    button.disabled = clearingJobs || removingJobIds.has(button.dataset.authorizeJobId) || pending;
    button.textContent = pending ? '正在授权…' : '选择文件夹并改名';
  }
}

async function removeJob(jobId) {
  if (clearingJobs || removingJobIds.has(jobId) || authorizingJobIds.has(jobId) || jobTitleEditors.get(jobId)?.pending) return;
  cancelJobTitleEdit(jobId);
  removingJobIds.add(jobId);
  updateJobActionButtons();
  try {
    await request('DELETE_JOB', { jobId });
    await refresh();
    notice('已移除任务，已保存的文件不会删除。');
  } catch (error) { notice(error.message || String(error), true); }
  finally {
    removingJobIds.delete(jobId);
    updateJobActionButtons();
  }
}

async function clearJobs() {
  if (clearingJobs || removingJobIds.size > 0 || authorizingJobIds.size > 0 || Array.from(jobTitleEditors.values()).some(editor => editor.pending) || currentState.jobs.length === 0) return;
  for (const jobId of jobTitleEditors.keys()) cancelJobTitleEdit(jobId);
  clearingJobs = true;
  updateJobActionButtons();
  try {
    await request('CLEAR_JOBS');
    await refresh();
    notice('已清空任务列表，已保存的文件不会删除。');
  } catch (error) { notice(error.message || String(error), true); }
  finally {
    clearingJobs = false;
    updateJobActionButtons();
  }
}

async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    const state = await request('GET_STATE', { tabId });
    currentState = { streams: state.streams || [], jobs: state.jobs || [], settings: state.settings || {} };
    if (!settingsLoaded) {
      applySettingsToControls(currentState.settings);
      settingsLoaded = true;
    }
    const streamSnapshot = JSON.stringify([currentState.streams, currentState.jobs.filter(job => activeStatuses.has(job.status)).map(({ url, tabId, title }) => ({ url, tabId, title }))]);
    if (streamSnapshot !== renderedStreams) { renderStreams(currentState.streams); renderedStreams = streamSnapshot; }
    const jobSnapshot = JSON.stringify(currentState.jobs.map(({ updatedAt, ...job }) => job));
    if (jobSnapshot !== renderedJobs) { renderJobs(currentState.jobs); renderedJobs = jobSnapshot; }
  } catch (error) { notice(error.message || String(error), true); }
  finally {
    refreshing = false;
    if (refreshAgain) { refreshAgain = false; scheduleRefresh(); }
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 120);
}

function renderSaveMode() {
  const automatic = $('auto-save').checked;
  $('save-mode-label').textContent = automatic ? '当前：按 Chrome 下载设置自动保存' : '当前：每次保存前选择位置';
  $('save-mode-label').classList.toggle('is-automatic', automatic);
}

function applySettingsToControls(settings) {
  $('auto-save').checked = settings.saveAs === false;
  const concurrency = String(settings.concurrency || 4);
  const retries = String(settings.retries ?? 3);
  $('download-concurrency').value = ['1', '2', '4', '6', '8'].includes(concurrency) ? concurrency : '4';
  $('download-retries').value = ['0', '1', '2', '3', '5'].includes(retries) ? retries : '3';
  renderSaveMode();
}

async function saveSettings(message) {
  const settings = {
    ...currentState.settings,
    saveAs: !$('auto-save').checked,
    concurrency: Number($('download-concurrency').value),
    retries: Number($('download-retries').value)
  };
  renderSaveMode();
  try {
    const result = await request('SAVE_SETTINGS', { settings });
    currentState.settings = result.settings || settings;
    notice(message);
  } catch (error) {
    applySettingsToControls(currentState.settings);
    notice(error.message || String(error), true);
  }
}

$('streams-tab').addEventListener('click', () => switchView('streams'));
$('jobs-tab').addEventListener('click', () => switchView('jobs'));
$('rescan').addEventListener('click', rescanStreams);
$('clear-streams').addEventListener('click', clearStreams);
for (const id of ['rescan', 'clear-streams']) {
  $(id).addEventListener('pointerdown', event => {
    if (streamTitleEditors.size) event.preventDefault();
  });
}
$('clear-jobs').addEventListener('click', clearJobs);
$('clear-jobs').addEventListener('pointerdown', event => {
  if (jobTitleEditors.size) event.preventDefault();
});
$('export-diagnostics').addEventListener('click', () => withButton($('export-diagnostics'), () => exportDiagnostics()));
$('clear-diagnostics').addEventListener('click', () => withButton($('clear-diagnostics'), async () => {
  await request('CLEAR_DIAGNOSTICS');
  notice('已清除本机诊断日志。');
}));
$('auto-save').addEventListener('change', async () => {
  await saveSettings($('auto-save').checked ? '已开启自动保存，将按 Chrome 下载设置保存。' : '已关闭自动保存，下载时将选择保存位置。');
});
$('download-concurrency').addEventListener('change', () => saveSettings(`已设置单个视频 ${$('download-concurrency').value} 路分片并发，将用于新任务。`));
$('download-retries').addEventListener('change', () => saveSettings(Number($('download-retries').value) ? `分片失败时最多重试 ${$('download-retries').value} 次，将用于新任务。` : '已关闭失败重试，将用于新任务。'));
$('manual-form').addEventListener('submit', (event) => {
  event.preventDefault();
  withButton($('manual-submit'), async () => {
    await startDownload(manualUrl(), $('manual-title').value.trim());
  });
});
$('manual-preview').addEventListener('click', () => withButton($('manual-preview'), () => openPreview(manualUrl(), $('manual-title').value.trim())));
$('manual-use-page-title').addEventListener('click', () => withButton($('manual-use-page-title'), async () => {
  const result = await request('GET_PAGE_TITLE', { tabId });
  if (!result.title) throw new Error('当前网页没有可用标题，请手动输入文件名。');
  $('manual-title').value = result.title;
  notice('已将当前网页标题填入文件名。');
}));
chrome.storage.onChanged.addListener((_changes, areaName) => {
  if (areaName === 'local' || areaName === 'session') scheduleRefresh();
});

async function initialize() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id ?? null;
    pageTitle = tab?.title || '';
    try {
      const url = new URL(tab?.url || '');
      $('page-host').textContent = url.hostname || '当前页面';
      if (!['http:', 'https:'].includes(url.protocol)) $('page-host').textContent = '请打开有视频的网页';
      onXPage = ['http:', 'https:'].includes(url.protocol) && isXHost(url.hostname);
      if (onXPage) {
        $('x-help').hidden = false;
        $('streams-empty-title').textContent = '等待 X 视频出现';
        $('streams-empty-description').textContent = '打开含视频的 X 帖子并播放；已打开页面刷新后再试。';
        $('streams-empty-hint').textContent = '请确认视频可以在 X 页面正常播放';
        if (isXPostUrl(url.href)) {
          $('x-post-link').href = url.href;
          $('x-post-link').title = pageTitle;
          $('x-post-link').hidden = false;
          $('x-page-title').textContent = pageTitle;
          $('x-page-title').title = pageTitle;
          $('x-page-title').hidden = !pageTitle;
        }
      }
    } catch { $('page-host').textContent = '请打开有视频的网页'; }
    await refresh();
    if (currentState.streams.length) switchView('streams');
    else if (currentState.jobs.some((job) => activeStatuses.has(job.status))) switchView('jobs');
  } catch (error) { notice(error.message || String(error), true); }
}

initialize();
setInterval(refresh, 1500);
