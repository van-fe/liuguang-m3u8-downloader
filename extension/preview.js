const $ = id => document.getElementById(id);
const previewId = new URL(location.href).searchParams.get('id');
let hls;
let source;
let mediaRecoveries = 0;
let jobId;
let refreshTimer;

async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (!result?.ok) throw new Error(result?.error || '插件后台未响应');
  return result;
}
function showError(message) {
  $('error').textContent = message;
  $('error').hidden = false;
  $('status').textContent = '预览未能继续';
}
function load() {
  if (!source) return;
  hls?.destroy();
  hls = null;
  mediaRecoveries = 0;
  $('error').hidden = true;
  $('status').textContent = '正在加载视频…';
  $('quality').replaceChildren(new Option('自动', '-1'));
  const direct = source.format === 'mp4' || /\.mp4$/i.test(new URL(source.url).pathname);
  $('quality').disabled = direct;
  if (direct) {
    $('video').src = source.url;
    $('video').load();
    $('status').textContent = '视频已就绪，点击播放';
    $('video').play().catch(() => {});
  } else if (Hls.isSupported()) {
    hls = new Hls({
      enableWorker: false, backBufferLength: 30, maxBufferLength: 30,
      xhrSetup: xhr => { xhr.withCredentials = true; }
    });
    hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
      for (const [index, level] of data.levels.entries()) {
        $('quality').append(new Option(level.height ? `${level.height}p` : `${Math.round(level.bitrate / 1000)} kbps`, String(index)));
      }
      $('status').textContent = '视频已就绪，点击播放';
      $('video').play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      console.warn('HLS preview:', data.type, data.details, data.error?.message || '');
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries++ < 1) {
        hls.recoverMediaError();
        return;
      }
      const code = data.response?.code;
      showError(data.type === Hls.ErrorTypes.NETWORK_ERROR
        ? `视频加载失败${code ? `（HTTP ${code}）` : ''}。请确认网页可正常播放，或重新检测链接。`
        : '浏览器无法播放此视频。可能是原视频编码不受支持，或使用了 DRM 保护。');
      hls.stopLoad();
    });
    hls.loadSource(source.url);
    hls.attachMedia($('video'));
  } else if ($('video').canPlayType('application/vnd.apple.mpegurl')) {
    $('video').src = source.url;
  } else showError('此浏览器不支持 HLS 预览，请使用较新版本的 Chrome。');
}
$('quality').addEventListener('change', () => { if (hls) hls.currentLevel = Number($('quality').value); });
$('retry').addEventListener('click', load);
$('video').addEventListener('playing', () => { $('status').textContent = '正在播放'; });
$('video').addEventListener('pause', () => { if (!$('video').ended) $('status').textContent = '已暂停'; });
$('video').addEventListener('ended', () => { $('status').textContent = '播放结束'; });
$('video').addEventListener('waiting', () => { $('status').textContent = '正在缓冲…'; });
$('video').addEventListener('error', () => {
  if (!hls) showError('无法播放该视频。请重新检测 X 帖子，确认视频地址仍然有效。');
});
$('download').addEventListener('click', async () => {
  $('download').disabled = true;
  try {
    const result = await request('START_DOWNLOAD', { url: source.url, title: source.title, tabId: source.tabId, streamId: source.streamId, previewId });
    jobId = result.jobId;
    $('download-status').hidden = false;
    $('download-status').textContent = '已加入下载队列，完成后保存为 MP4。';
    refreshTimer = setInterval(async () => {
      try {
        const state = await request('GET_STATE');
        const job = state.jobs.find(item => item.id === jobId);
        if (!job) return;
        const labels = { queued: '等待下载', preparing: '准备视频', downloading: '下载分片', converting: '合并 MP4', saving: '正在保存', complete: 'MP4 已保存', error: '下载失败', cancelled: '已取消' };
        $('download-status').textContent = job.error || `${labels[job.status] || '处理中'}${job.status === 'downloading' ? ` ${Math.round(job.progress || 0)}%` : ''}`;
        if (['complete', 'error', 'cancelled'].includes(job.status)) { clearInterval(refreshTimer); $('download').disabled = false; }
      } catch { clearInterval(refreshTimer); $('download').disabled = false; }
    }, 1000);
  } catch (error) { showError(error.message); $('download').disabled = false; }
});
window.addEventListener('pagehide', () => { hls?.destroy(); clearInterval(refreshTimer); });
try {
  const stored = await chrome.storage.session.get('previewSources');
  source = stored.previewSources?.[previewId];
  if (!source || !['http:', 'https:'].includes(new URL(source.url).protocol)) throw new Error('预览链接已失效，请从插件重新打开预览。');
  $('title').textContent = source.title || '视频预览';
  document.title = `${source.title || '视频预览'} · 流光`;
  $('source').textContent = new URL(source.url).hostname;
  $('download').disabled = false;
  load();
} catch (error) { showError(error.message); }
