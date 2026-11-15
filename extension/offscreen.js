import { FFmpeg } from './vendor/ffmpeg/index.js';
import { resolveTracks, downloadTracks, buildFFmpegArgs } from './lib/download.js';
import { sanitizeFilename } from './lib/hls.js';
import { createDownloadDisk, cleanupAbandonedDownloads, explainDiskError } from './lib/disk.js';
import { requestToSink } from './lib/network.js';
import { createJobDiagnostic, describeMergeFailure, summarizeTracks } from './lib/diagnostics.js';

const queue = [];
const blobs = new Map();
const active = new Map();
let automaticSaves = Promise.resolve();
let nextAutomaticSaveAt = 0;
const diskReady = cleanupAbandonedDownloads();
diskReady.catch(() => {});

async function send(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (result?.ok === false) throw new Error(result.error || '后台通信失败');
  return result;
}

async function saveToBrowser(job, controller, data) {
  const { signal } = controller;
  signal.throwIfAborted();
  if (job.saveAs !== false) return send('SAVE_BLOB', data);
  const pending = automaticSaves.then(async () => {
    signal.throwIfAborted();
    const delay = Math.max(0, nextAutomaticSaveAt - Date.now());
    if (delay) await new Promise((resolve, reject) => {
      const finish = () => {
        signal.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(finish, delay);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
    });
    signal.throwIfAborted();
    try { return await send('SAVE_BLOB', data); }
    // Space native automatic-save clicks so Chrome does not silently drop a burst.
    finally { nextAutomaticSaveAt = Date.now() + 150; }
  });
  automaticSaves = pending.catch(() => {});
  return pending;
}

function runNext() {
  while (queue.length) {
    const entry = queue.shift();
    const run = { controller: new AbortController(), ffmpeg: null, cancelled: false };
    active.set(entry.job.id, run);
    void runJob(entry, run).catch(error => {
      console.warn('下载任务清理失败', error?.name || 'Error');
    });
  }
}

async function runJob({ job, settings, extensionVersion }, run) {
  const { controller } = run;
  let ffmpeg;
  let diagnostic;
  let heartbeat;
  let disk;
  let state = { status: 'preparing', progress: 0 };
  let stage = 'initializing';
  let handedToBrowser = false;
  let lastUpdate = 0;
  let lastDiagnostic = 0;
  let sending = Promise.resolve();
  let diagnosticWrites = Promise.resolve();
  const persistDiagnostic = () => {
    if (!diagnostic) return Promise.resolve();
    try {
      const report = diagnostic.snapshot();
      lastDiagnostic = Date.now();
      diagnosticWrites = diagnosticWrites.catch(() => {}).then(() => send('JOB_DIAGNOSTIC', { jobId: job.id, report })).catch(error => {
        console.warn('诊断日志保存失败', error?.name || 'Error');
      });
      return diagnosticWrites;
    } catch (error) {
      console.warn('诊断日志保存失败', error?.name || 'Error');
      return Promise.resolve();
    }
  };
  const step = value => { stage = value; diagnostic?.event('stage', { stage }); };
  const update = (patch, force = false) => {
    Object.assign(state, patch);
    diagnostic?.progress(state);
    if (!force && Date.now() - lastUpdate < 400) return;
    lastUpdate = Date.now();
    const snapshot = { ...state };
    sending = sending.catch(() => {}).then(() => send('JOB_UPDATE', { jobId: job.id, patch: snapshot }));
    // Status updates must not create an unhandled rejection if Chrome is shutting down.
    sending.catch(() => {});
    const pending = force || Date.now() - lastDiagnostic >= 5000 ? sending.then(persistDiagnostic) : sending;
    pending.catch(() => {});
    return pending;
  };
  try {
    ffmpeg = run.ffmpeg = new FFmpeg();
    diagnostic = createJobDiagnostic(job, settings, {
      // Offscreen documents expose a restricted runtime API without getManifest.
      version: extensionVersion || '', userAgent: globalThis.navigator?.userAgent || '',
    });
    heartbeat = setInterval(() => update({}, true), 20000);
    await update(state, true);
    await diskReady;
    controller.signal.throwIfAborted();
    step('creating-disk-cache');
    disk = await createDownloadDisk(job.id);
    controller.signal.throwIfAborted();
    if (job.format === 'mp4') {
      step('downloading-mp4');
      await update({ status: 'downloading', totalSegments: 1, completedSegments: 0, retryCount: 0 }, true);
      let totalBytes = 0;
      const downloaded = await requestToSink(job.url, {
        signal: controller.signal, retries: settings?.retries ?? 3,
        createSink: () => disk.createOutputSink(),
        onResponse: response => {
          diagnostic.event('resource-response', { httpStatus: response.status, mime: response.headers.get('content-type'), declaredBytes: Number(response.headers.get('content-length')) || null });
          if (/text\/html|application\/json/i.test(response.headers.get('content-type') || '')) throw new Error('视频地址返回了网页，请重新检测 X 帖子。');
          totalBytes = Number(response.headers.get('content-length')) || 0;
        },
        onRetry: ({ attempt, error }) => {
          diagnostic.event('resource-retry', { attempt, message: error?.message });
          update({ bytes: 0, retryCount: (state.retryCount || 0) + 1 });
        },
        onProgress: ({ bytes }) => update({ bytes, progress: totalBytes ? Math.min(95, Math.round(bytes / totalBytes * 95)) : 0 })
      });
      controller.signal.throwIfAborted();
      await update({ bytes: downloaded.bytes, completedSegments: 1, progress: 97 }, true);
    } else {
      step('resolving-hls');
      const onDiagnostic = (event, details) => diagnostic.event(event, details);
      const tracks = await resolveTracks(job.url, { signal: controller.signal, quality: job.quality, retries: settings?.retries ?? 3, onDiagnostic });
      diagnostic.report.tracks = summarizeTracks(tracks);
      step('downloading-segments');
      await update({ status: 'downloading', totalSegments: tracks.video.segments.length + (tracks.audio?.segments.length || 0) }, true);
      const downloaded = await downloadTracks(tracks, {
        signal: controller.signal, concurrency: settings?.concurrency || 4, retries: settings?.retries ?? 3,
        createSink: filename => disk.createSink(filename),
        writeFile: (path, data) => disk.writeFile(path, data),
        onProgress: patch => update(patch), onDiagnostic,
      });
      controller.signal.throwIfAborted();
      step('loading-media-engine');
      await update({ ...downloaded, inputs: undefined, status: 'converting', progress: 88 }, true);
      ffmpeg.on('log', entry => diagnostic.log(entry));
      await ffmpeg.load({
        classWorkerURL: chrome.runtime.getURL('media-worker.js'),
        coreURL: chrome.runtime.getURL('vendor/ffmpeg-core/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('vendor/ffmpeg-core/ffmpeg-core.wasm')
      });
      controller.signal.throwIfAborted();
      step('mounting-media-files');
      await ffmpeg.createDir('/input');
      await ffmpeg.createDir('/output');
      const files = await disk.files();
      diagnostic.event('disk-inputs', { count: files.length, totalBytes: files.reduce((sum, file) => sum + file.size, 0), largestBytes: files.reduce((max, file) => Math.max(max, file.size), 0) });
      // Structured cloning a File preserves its disk backing; it does not read the file.
      await ffmpeg.mount('WORKERFS', { files }, '/input');
      await ffmpeg.mount('OPFS', { fileHandle: disk.output }, '/output');
      ffmpeg.on('progress', ({ progress }) => {
        if (Number.isFinite(progress)) update({ progress: Math.max(state.progress, Math.min(97, 88 + progress * 9)) });
      });
      const args = buildFFmpegArgs(downloaded.inputs.map(filename => `/input/${filename}`), { output: '/output/output.mp4' });
      diagnostic.report.ffmpeg.args = args;
      step('merging-mp4');
      await persistDiagnostic();
      let exitCode;
      try { exitCode = await ffmpeg.exec(args); }
      catch (error) {
        controller.signal.throwIfAborted();
        throw new Error(describeMergeFailure(null, diagnostic.report.ffmpeg.logs, error));
      }
      diagnostic.report.ffmpeg.exitCode = exitCode;
      controller.signal.throwIfAborted();
      if (exitCode !== 0) throw new Error(describeMergeFailure(exitCode, diagnostic.report.ffmpeg.logs));
      step('finalizing-mp4');
      // Release the exclusive sync handle before creating a stable disk File snapshot.
      await ffmpeg.unmount('/output');
      await ffmpeg.unmount('/input');
      ffmpeg.terminate();
    }
    step('validating-output');
    await disk.clearInputs();
    controller.signal.throwIfAborted();
    const output = await disk.output.getFile();
    diagnostic.event('output-created', { bytes: output.size });
    if (output.size < 32) throw new Error('转换结果为空，请重新检测后再试');
    if (job.format === 'mp4') {
      const header = new Uint8Array(await output.slice(0, 12).arrayBuffer());
      if (new TextDecoder().decode(header.subarray(4, 8)) !== 'ftyp') throw new Error('该地址未返回有效的 MP4 文件，请重新检测后再试。');
    }
    // File.slice keeps the disk backing and supplies the correct download MIME.
    const blob = URL.createObjectURL(output.slice(0, output.size, 'video/mp4'));
    blobs.set(job.id, { url: blob, disk });
    try {
      step('saving-to-browser');
      await update({ status: 'saving', progress: 98 }, true);
      controller.signal.throwIfAborted();
      await saveToBrowser(job, controller, { jobId: job.id, url: blob, filename: sanitizeFilename(job.title || 'video'), saveAs: job.saveAs !== false });
      handedToBrowser = true;
    } catch (error) {
      URL.revokeObjectURL(blob);
      blobs.delete(job.id);
      throw error;
    }
  } catch (error) {
    diagnostic?.fail(error, stage, run.cancelled);
    controller.abort(error);
    await update({
      status: run.cancelled ? 'cancelled' : 'error',
      error: run.cancelled ? '' : explainDiskError(error)
    }, true).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    try {
      try { ffmpeg?.terminate(); }
      finally {
        if (!handedToBrowser) await persistDiagnostic();
        if (disk && !blobs.has(job.id)) await disk.remove();
      }
    } finally {
      active.delete(job.id);
      runNext();
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  if (message.type === 'RUN_JOB') {
    if (!queue.some(item => item.job.id === message.job.id) && !active.has(message.job.id) && !blobs.has(message.job.id)) {
      queue.push({ job: message.job, settings: message.settings, extensionVersion: message.extensionVersion });
    }
    runNext();
    respond({ ok: true });
  } else if (message.type === 'SET_TASK_CONCURRENCY') {
    // Older settings messages cannot restore a limit on simultaneous tasks.
    runNext();
    respond({ ok: true });
  } else if (message.type === 'SAVE_WITH_ANCHOR') {
    const entry = blobs.get(message.jobId);
    if (!entry || message.url !== entry.url) {
      respond({ ok: false, error: '本地视频文件已释放，请重新下载。' });
      return;
    }
    try {
      const anchor = document.createElement('a');
      anchor.href = entry.url;
      anchor.download = sanitizeFilename(message.filename || 'video');
      anchor.hidden = true;
      document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); }
      respond({ ok: true });
    } catch (error) {
      respond({ ok: false, error: error?.message || '无法启动本地文件保存。' });
    }
  } else if (message.type === 'CANCEL_JOB') {
    const index = queue.findIndex(item => item.job.id === message.jobId);
    if (index >= 0) {
      queue.splice(index, 1);
      void send('JOB_UPDATE', { jobId: message.jobId, patch: { status: 'cancelled' } }).catch(() => {});
    }
    const run = active.get(message.jobId);
    if (run) {
      run.cancelled = true;
      run.controller.abort(new DOMException('已取消下载', 'AbortError'));
      run.ffmpeg?.terminate();
    }
    respond({ ok: true });
  } else if (message.type === 'RELEASE_BLOB') {
    const entry = blobs.get(message.jobId);
    if (entry) {
      URL.revokeObjectURL(entry.url);
      void entry.disk.remove().catch(error => console.warn('下载缓存清理失败', error?.name || 'Error'));
    }
    blobs.delete(message.jobId);
    respond({ ok: true });
  }
});
