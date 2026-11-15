import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import * as xMedia from '../extension/lib/x-media.js';
import { resolveXPost } from '../extension/lib/x-resolver.js';
import { createDiagnosticStore } from '../extension/lib/diagnostic-store.js';
import { createDownloadNameStore, isOwnDownloadBlob, sanitizeDownloadName, DOWNLOAD_NAMES_STORAGE_KEY } from '../extension/lib/download-names.js';
import { sanitizeFilename } from '../extension/lib/hls.js';
import { getStreamTitle } from '../extension/lib/stream-names.js';
import { getLocalDownloadInfo, LocalDirectoryAuthorizationRequired } from '../extension/lib/local-downloads.js';

const source = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'))
  .replace(/^import[^\r\n]*$/gm, '');
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionOrigin = `chrome-extension://${extensionId}/`;
const popup = { id: extensionId, url: `${extensionOrigin}popup.html`, tab: { id: 91 } };
const offscreen = { id: extensionId, url: `${extensionOrigin}offscreen.html` };
const content = { id: extensionId, url: 'https://video.example/watch', tab: { id: 3 } };
const copy = value => structuredClone(value);

function event() {
  const listeners = [];
  return { listeners, addListener: listener => listeners.push(listener) };
}

function storage() {
  const values = {};
  return {
    values,
    async get(keys) {
      const names = typeof keys === 'string' ? [keys] : keys || Object.keys(values);
      return copy(Object.fromEntries(names.filter(key => key in values).map(key => [key, values[key]])));
    },
    async set(data) { Object.assign(values, copy(data)); }
  };
}

function harness({ download, sendMessage, fetchImpl, getTab, sessionStorage, localStorage, getContexts, search, executeScript, renameLocal, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
  const calls = { download: [], cancel: [], erase: [], removeFile: [], offscreen: [], scripts: [], errors: [], fetch: [], createdTabs: [] };
  const chrome = {
    runtime: {
      id: extensionId,
      getURL: path => `${extensionOrigin}${path}`,
      async getContexts() { return getContexts ? getContexts() : [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: offscreen.url }]; },
      async sendMessage(message) {
        calls.offscreen.push(copy(message));
        if (sendMessage) return sendMessage(message);
        if (message.type === 'SAVE_WITH_ANCHOR') queueMicrotask(() => {
          chrome.downloads.onCreated.listeners[0]({ id: 72, url: message.url, state: 'in_progress' });
        });
        return { ok: true };
      },
      onMessage: event()
    },
    storage: { local: localStorage || storage(), session: sessionStorage || storage() },
    downloads: {
      async download(options) { calls.download.push(copy(options)); return download ? download(options) : 72; },
      async search({ id }) { return search ? search(id) : [{ id, state: 'in_progress' }]; },
      async cancel(id) { calls.cancel.push(id); },
      async erase(query) { calls.erase.push(copy(query)); },
      async removeFile(id) { calls.removeFile.push(id); },
      async show() {},
      onCreated: event(),
      onChanged: event()
    },
    offscreen: { async createDocument() {} },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    webRequest: { onBeforeRequest: event(), onHeadersReceived: event() },
    tabs: {
      onUpdated: event(), onRemoved: event(), async sendMessage() {},
      async get(tabId) { return getTab ? getTab(tabId) : { id: tabId, url: content.url, title: 'Video' }; },
      async create(options) { calls.createdTabs.push(copy(options)); return { id: 13 }; }
    },
    scripting: { async executeScript(options) {
      calls.scripts.push(options);
      return executeScript ? executeScript(options) : [{ frameId: 0, result: 'Live page title' }];
    } }
  };
  const fetch = async (...args) => {
    calls.fetch.push(args);
    if (!fetchImpl) throw new Error('Unexpected network request in background unit test.');
    return fetchImpl(...args);
  };
  vm.runInNewContext(source, {
    ...xMedia, resolveXPost, createDiagnosticStore, createDownloadNameStore, isOwnDownloadBlob, sanitizeDownloadName, sanitizeFilename, getStreamTitle,
    getLocalDownloadInfo: job => getLocalDownloadInfo(job, { downloads: chrome.downloads }),
    renameLocalDownload: renameLocal || (async () => { throw new LocalDirectoryAuthorizationRequired(); }),
    chrome, crypto: webcrypto, URL, URLSearchParams, AbortController, DOMException,
    fetch, setTimeout: setTimeoutImpl, clearTimeout: clearTimeoutImpl, console: { error: (...args) => calls.errors.push(args) }
  }, { filename: 'background.js' });
  const listener = chrome.runtime.onMessage.listeners[0];
  assert.ok(listener);
  const request = (type, data = {}, sender = popup) => new Promise(resolve => {
    assert.equal(listener({ target: 'background', type, ...data }, sender, value => resolve(copy(value))), true);
  });
  return {
    chrome, calls, request,
    async createJob(url = 'https://cdn.example/video.m3u8', saveAs = true) {
      const response = await request('START_DOWNLOAD', { url, title: 'test', tabId: 3, saveAs });
      assert.equal(response.ok, true, response.error);
      return response.jobId;
    },
    async state() { return request('GET_STATE', { tabId: 3 }); }
  };
}

const blobRequest = jobId => ({ jobId, url: `blob:${extensionOrigin}stable-file`, filename: 'test.mp4' });

test('cancellation queued before SAVE_BLOB prevents a late browser download', async () => {
  const h = harness();
  const jobId = await h.createJob();
  // Both dispatches reach their first state check before queued mutations run.
  const [cancelled, saved] = await Promise.all([
    h.request('CANCEL_JOB', { jobId }),
    h.request('SAVE_BLOB', blobRequest(jobId), offscreen)
  ]);
  assert.equal(cancelled.ok, true);
  assert.equal(saved.ok, false);
  assert.match(saved.error, /任务已结束/);
  assert.equal(h.calls.download.length, 0);
  assert.equal((await h.state()).jobs[0].status, 'cancelled');
});

test('completion queued before CANCEL_JOB remains complete', async () => {
  const h = harness();
  const jobId = await h.createJob();
  const [updated, cancelled] = await Promise.all([
    h.request('JOB_UPDATE', { jobId, patch: { status: 'complete', progress: 100 } }, offscreen),
    h.request('CANCEL_JOB', { jobId })
  ]);
  assert.equal(updated.ok, true);
  assert.equal(cancelled.ok, true);
  assert.equal((await h.state()).jobs[0].status, 'complete');
  assert.equal(h.calls.offscreen.filter(message => message.type === 'CANCEL_JOB').length, 0);
});

test('cancellation while downloads.download is pending cancels its eventual id', async () => {
  let finishDownload;
  let signalDownloadStarted;
  const downloadStarted = new Promise(resolve => { signalDownloadStarted = resolve; });
  const h = harness({
    download() {
      signalDownloadStarted();
      return new Promise(resolve => { finishDownload = resolve; });
    }
  });
  const jobId = await h.createJob();
  const saving = h.request('SAVE_BLOB', blobRequest(jobId), offscreen);
  await downloadStarted;
  assert.equal((await h.state()).jobs[0].status, 'saving');
  assert.equal((await h.request('CANCEL_JOB', { jobId })).ok, true);
  finishDownload(412);
  assert.equal((await saving).ok, true);
  assert.deepEqual(h.calls.cancel, [412]);
  const [job] = (await h.state()).jobs;
  assert.equal(job.status, 'cancelled');
  assert.equal(job.downloadId, 412);
});

test('a late engine dispatch failure cannot overwrite an already cancelled job', async () => {
  let rejectEngine;
  let signalEngineStarted;
  const engineStarted = new Promise(resolve => { signalEngineStarted = resolve; });
  const h = harness({
    sendMessage(message) {
      if (message.type !== 'RUN_JOB') return { ok: true };
      signalEngineStarted();
      return new Promise((_resolve, reject) => { rejectEngine = reject; });
    }
  });
  const creating = h.request('START_DOWNLOAD', { url: 'https://cdn.example/video.m3u8', tabId: 3 });
  await engineStarted;
  const jobId = (await h.state()).jobs[0].id;
  await h.request('CANCEL_JOB', { jobId });
  rejectEngine(new Error('engine stopped'));
  assert.equal((await creating).ok, false);
  assert.equal((await h.state()).jobs[0].status, 'cancelled');
});

test('content scripts may report HTTP streams but cannot start jobs or save blobs', async () => {
  const h = harness();
  assert.equal((await h.request('DETECT_STREAMS', {
    urls: ['https://cdn.example/manifest', 'javascript:alert(1)', 'file:///private/video.m3u8'], title: 'Video'
  }, content)).ok, true);
  const detected = await h.state();
  assert.equal(detected.streams.length, 1);
  assert.equal(detected.streams[0].url, 'https://cdn.example/manifest');
  const started = await h.request('START_DOWNLOAD', { url: 'https://cdn.example/video.m3u8' }, content);
  assert.equal(started.ok, false);
  assert.match(started.error, /插件窗口/);
  const jobId = await h.createJob();
  const saved = await h.request('SAVE_BLOB', blobRequest(jobId), content);
  assert.equal(saved.ok, false);
  assert.match(saved.error, /下载引擎/);
  assert.equal(h.calls.download.length, 0);
  const forgedOffscreen = await h.request('SAVE_BLOB', blobRequest(jobId), { ...offscreen, tab: { id: 3 } });
  assert.equal(forgedOffscreen.ok, false);
});

test('parallel starts deduplicate a URL and accept a large queue without a task-count cap', async () => {
  const h = harness();
  const duplicates = await Promise.all(Array.from({ length: 12 }, () => h.request('START_DOWNLOAD', { url: 'https://cdn.example/same.m3u8' })));
  assert.ok(duplicates.every(response => response.ok));
  assert.equal(new Set(duplicates.map(response => response.jobId)).size, 1);
  assert.equal(h.calls.offscreen.filter(message => message.type === 'RUN_JOB').length, 1);
  const others = await Promise.all(Array.from({ length: 100 }, (_, index) => h.request('START_DOWNLOAD', { url: `https://cdn.example/${index}.m3u8` })));
  for (const response of others) assert.equal(response.ok, true, response.error);
  const expectedIds = new Set([duplicates[0].jobId, ...others.map(response => response.jobId)]);
  assert.equal(expectedIds.size, 101);
  const { jobs } = await h.state();
  assert.equal(jobs.length, expectedIds.size);
  assert.ok(jobs.every(job => job.status === 'queued'));
  assert.deepEqual(new Set(jobs.map(job => job.id)), expectedIds);
  assert.deepEqual(new Set(h.chrome.storage.session.values.jobs.map(job => job.id)), expectedIds);
  const dispatched = h.calls.offscreen.filter(message => message.type === 'RUN_JOB');
  assert.equal(dispatched.length, expectedIds.size);
  assert.deepEqual(new Set(dispatched.map(message => message.job.id)), expectedIds);
});

test('legacy task limits migrate to unlimited without changing segment, retry, or save preferences', async () => {
  const localStorage = storage();
  await localStorage.set({ settings: { saveAs: false, taskConcurrency: 1, concurrency: 8, retries: 1 } });
  const h = harness({ localStorage });
  assert.deepEqual((await h.state()).settings, { saveAs: false, taskConcurrency: 'unlimited', concurrency: 8, retries: 1 });
  assert.equal(localStorage.values.settings.taskConcurrency, 'unlimited');
  await h.createJob();
  assert.equal(h.calls.offscreen.find(message => message.type === 'RUN_JOB').settings.taskConcurrency, 'unlimited');
});

test('outdated settings requests cannot restore a finite task limit or interrupt existing jobs', async () => {
  const h = harness();
  const jobId = await h.createJob();
  for (const value of [1, 3, 8, 99, '4', 2.5, null]) {
    const saved = await h.request('SAVE_SETTINGS', { settings: { taskConcurrency: value } });
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.taskConcurrency, 'unlimited');
    assert.equal(h.chrome.storage.local.values.settings.taskConcurrency, 'unlimited');
  }
  assert.deepEqual(h.calls.offscreen.filter(message => message.type === 'SET_TASK_CONCURRENCY'), []);
  const job = (await h.state()).jobs.find(job => job.id === jobId);
  assert.equal(job.status, 'queued');
  assert.equal(h.calls.offscreen.filter(message => message.type === 'CANCEL_JOB').length, 0);
  await h.createJob('https://cdn.example/next.m3u8');
  assert.equal(h.calls.offscreen.filter(message => message.type === 'RUN_JOB').at(-1).settings.taskConcurrency, 'unlimited');
});

test('unlimited tasks retain trusted settings access and independent segment and retry preferences', async () => {
  const h = harness();
  for (const sender of [content, offscreen, { ...popup, id: 'another-extension' }]) {
    assert.equal((await h.request('SAVE_SETTINGS', { settings: { taskConcurrency: 8 } }, sender)).ok, false);
  }
  assert.equal((await h.state()).settings.taskConcurrency, 'unlimited');
  assert.equal(h.calls.offscreen.length, 0);
  const saved = await h.request('SAVE_SETTINGS', { settings: { taskConcurrency: 1, concurrency: 6, retries: 5, saveAs: false } });
  assert.deepEqual(saved.settings, { saveAs: false, taskConcurrency: 'unlimited', concurrency: 6, retries: 5 });
  assert.deepEqual(h.chrome.storage.local.values.settings, saved.settings);
});

test('unlimited task processing remains enabled across worker restarts without creating an engine for settings', async () => {
  const localStorage = storage();
  const h = harness({ localStorage, getContexts: () => [] });
  h.chrome.offscreen.createDocument = async () => { assert.fail('Saving settings must not create a download engine.'); };
  assert.equal((await h.request('SAVE_SETTINGS', { settings: { taskConcurrency: 6 } })).ok, true);
  assert.equal(h.calls.offscreen.length, 0);
  const restarted = harness({ localStorage });
  assert.equal((await restarted.state()).settings.taskConcurrency, 'unlimited');
  await restarted.createJob();
  assert.equal(restarted.calls.offscreen.find(message => message.type === 'RUN_JOB').settings.taskConcurrency, 'unlimited');
});

const xPostId = '1845922924315938922';
const xPostUrl = `https://x.com/SpaceX/status/${xPostId}`;
const xMP4Small = 'https://video.twimg.com/ext_tw_video/1845922604009639947/pu/vid/avc1/640x360/small.mp4?tag=14';
const xMP4Best = 'https://video.twimg.com/ext_tw_video/1845922604009639947/pu/vid/avc1/1920x1080/best.mp4?tag=14';
const xHLS = 'https://video.twimg.com/ext_tw_video/1845922604009639947/pu/pl/master.m3u8?tag=14';
const xContent = { id: extensionId, url: xPostUrl, tab: { id: 3 } };
const publicXPayload = {
  __typename: 'Tweet', id_str: xPostId, text: 'Tower view of the first Super Heavy booster catch',
  user: { screen_name: 'SpaceX', name: 'SpaceX' },
  mediaDetails: [{
    id_str: '1845922604009639947', type: 'video',
    video_info: { duration_millis: 21755, variants: [
      { content_type: 'application/x-mpegURL', url: xHLS },
      { content_type: 'video/mp4', bitrate: 832000, url: xMP4Small },
      { content_type: 'video/mp4', bitrate: 10368000, url: xMP4Best }
    ] }
  }]
};
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('X content metadata groups variants and manual post download reuses detected media', async () => {
  const h = harness();
  const items = xMedia.extractXMedia(publicXPayload);
  assert.equal(items.length, 1);
  assert.equal((await h.request('DETECT_X_MEDIA', { items }, xContent)).ok, true);
  assert.equal((await h.request('DETECT_X_MEDIA', { items }, xContent)).ok, true);
  const detected = (await h.state()).streams.filter(stream => stream.platform === 'x');
  assert.equal(detected.length, 1);
  assert.equal(detected[0].postId, xPostId);
  assert.equal(detected[0].variants.length, 3);
  assert.equal(detected[0].format, 'mp4');
  assert.equal(detected[0].url, xMP4Best);
  const started = await h.request('START_DOWNLOAD', { url: xPostUrl, tabId: 3, saveAs: false });
  assert.equal(started.ok, true, started.error);
  const job = (await h.state()).jobs.find(item => item.id === started.jobId);
  assert.equal(job.url, xMP4Best);
  assert.equal(job.format, 'mp4');
  assert.equal(job.platform, 'x');
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.calls.download.length, 0, 'Remote MP4 must use the offscreen disk pipeline.');
  assert.equal(h.calls.offscreen.find(message => message.type === 'RUN_JOB').job.url, xMP4Best);
});

test('X metadata accepts only X page senders and never retains malicious variant hosts', async () => {
  const h = harness();
  const items = xMedia.extractXMedia(publicXPayload);
  const wrongSender = await h.request('DETECT_X_MEDIA', { items }, content);
  assert.equal(wrongSender.ok, false);
  const spoofedDomain = { ...xContent, url: `https://x.com.attacker.example/SpaceX/status/${xPostId}` };
  assert.equal((await h.request('DETECT_X_MEDIA', { items }, spoofedDomain)).ok, false);
  assert.equal((await h.state()).streams.length, 0);
  const malicious = copy(items[0]);
  malicious.variants.push({ url: 'https://video.twimg.com.attacker.example/private.mp4', type: 'mp4', bitrate: 99999999 });
  malicious.url = malicious.variants.at(-1).url;
  await h.request('DETECT_X_MEDIA', { items: [malicious] }, xContent);
  for (const stream of (await h.state()).streams) {
    assert.ok(xMedia.isXMediaUrl(stream.url));
    assert.ok(stream.variants.every(variant => xMedia.isXMediaUrl(variant.url)));
  }
  assert.equal(h.calls.download.length, 0);
  assert.equal(h.calls.offscreen.length, 0);
});

test('manual X post fallback requests public metadata without credentials and starts a local MP4 job', async () => {
  const h = harness({ fetchImpl: async () => jsonResponse(publicXPayload) });
  const started = await h.request('START_DOWNLOAD', { url: xPostUrl, tabId: 3, saveAs: false });
  assert.equal(started.ok, true, started.error);
  assert.equal(h.calls.fetch.length, 1);
  const [apiUrl, options] = h.calls.fetch[0];
  const parsed = new URL(apiUrl);
  assert.equal(parsed.origin, 'https://cdn.syndication.twimg.com');
  assert.equal(parsed.pathname, '/tweet-result');
  assert.equal(parsed.searchParams.get('id'), xPostId);
  assert.equal(parsed.searchParams.get('token'), '4h34yprw8d3');
  assert.equal(options.credentials, 'omit');
  assert.ok(!Object.keys(options.headers || {}).some(header => /authorization|cookie|user-agent/i.test(header)));
  const job = (await h.state()).jobs.find(item => item.id === started.jobId);
  assert.equal(job.url, xMP4Best);
  assert.equal(job.format, 'mp4');
  assert.equal(h.calls.download.length, 0);
  assert.equal(h.calls.offscreen.find(message => message.type === 'RUN_JOB').job.url, xMP4Best);
});

test('manual X preview resolves to the media URL rather than a post HTML page', async () => {
  const h = harness({ fetchImpl: async () => jsonResponse(publicXPayload) });
  const opened = await h.request('OPEN_PREVIEW', { url: xPostUrl, tabId: 3 });
  assert.equal(opened.ok, true, opened.error);
  assert.equal(h.calls.createdTabs.length, 1);
  assert.ok(h.calls.createdTabs[0].url.startsWith(`${extensionOrigin}preview.html?id=`));
  const sources = Object.values(h.chrome.storage.session.values.previewSources);
  assert.equal(sources.length, 1);
  assert.equal(sources[0].url, xMP4Best);
});

test('unavailable public X metadata creates no job and does not attempt authentication', async () => {
  const h = harness({ fetchImpl: async () => jsonResponse({}) });
  const started = await h.request('START_DOWNLOAD', { url: xPostUrl, tabId: 3 });
  assert.equal(started.ok, false);
  assert.match(started.error, /公开|登录|视频|获取/);
  assert.equal((await h.state()).jobs.length, 0);
  assert.equal(h.calls.offscreen.length, 0);
  assert.equal(h.calls.download.length, 0);
  assert.equal(h.calls.fetch.length, 1);
});

test('multi-video post indices remain stable on the public lookup and subsequent cached starts', async () => {
  const secondMediaId = '1845922604009639948';
  const secondMP4 = `https://video.twimg.com/ext_tw_video/${secondMediaId}/pu/vid/avc1/1280x720/second.mp4?tag=14`;
  const twoVideos = copy(publicXPayload);
  twoVideos.mediaDetails.push({
    id_str: secondMediaId, type: 'video',
    video_info: { duration_millis: 9000, variants: [{ content_type: 'video/mp4', bitrate: 2176000, url: secondMP4 }] }
  });
  const h = harness({ fetchImpl: async () => jsonResponse(twoVideos) });
  const first = await h.request('START_DOWNLOAD', { url: `${xPostUrl}/video/1`, tabId: 3, saveAs: false });
  assert.equal(first.ok, true, first.error);
  assert.equal((await h.state()).jobs.find(job => job.id === first.jobId).url, xMP4Best);
  const firstCached = await h.request('START_DOWNLOAD', { url: `${xPostUrl}/video/1`, tabId: 3, saveAs: false });
  assert.equal(firstCached.ok, true, firstCached.error);
  assert.equal(firstCached.jobId, first.jobId, 'The cached first video should deduplicate the same active job.');
  const second = await h.request('START_DOWNLOAD', { url: `${xPostUrl}/video/2`, tabId: 3, saveAs: false });
  assert.equal(second.ok, true, second.error);
  assert.notEqual(second.jobId, first.jobId);
  assert.equal((await h.state()).jobs.find(job => job.id === second.jobId).url, secondMP4);
  assert.equal(h.calls.fetch.length, 1, 'Complete cached metadata should avoid repeated public requests.');
  assert.equal(h.calls.offscreen.filter(message => message.type === 'RUN_JOB').length, 2);
});

test('X network discovery upgrades to full metadata and later child requests preserve the best MP4', async () => {
  const h = harness();
  assert.equal((await h.request('DETECT_STREAMS', { urls: [xHLS], title: 'X player' }, xContent)).ok, true);
  let streams = (await h.state()).streams;
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, xHLS);
  assert.equal(streams[0].metadataComplete, false);
  assert.equal((await h.request('DETECT_X_MEDIA', { items: xMedia.extractXMedia(publicXPayload) }, xContent)).ok, true);
  const childHLS = 'https://video.twimg.com/ext_tw_video/1845922604009639947/pu/pl/avc1/1920x1080/child.m3u8';
  assert.equal((await h.request('DETECT_STREAMS', { urls: [childHLS, xMP4Small] }, xContent)).ok, true);
  streams = (await h.state()).streams;
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, xMP4Best);
  assert.equal(streams[0].format, 'mp4');
  assert.equal(streams[0].metadataComplete, true);
  assert.equal(streams[0].postId, xPostId);
  assert.ok(streams[0].variants.some(variant => variant.url === childHLS));
});

test('repeated X cache copies across tabs preserve raw media identity and UI id', async () => {
  const h = harness();
  const items = xMedia.extractXMedia(publicXPayload);
  await h.request('DETECT_X_MEDIA', { items }, xContent);
  const mediaId = items[0].id;
  for (const tabId of [4, 5, 3, 4]) {
    const resolved = await h.request('RESOLVE_X_POST', { url: xPostUrl, tabId });
    assert.equal(resolved.ok, true, resolved.error);
    assert.equal(resolved.streams.length, 1);
    assert.equal(resolved.streams[0].mediaId, mediaId);
    assert.equal(resolved.streams[0].id, `x-${mediaId}`);
    assert.equal(resolved.streams[0].metadataComplete, true);
    const state = await h.request('GET_STATE', { tabId });
    assert.equal(state.streams.length, 1);
    assert.equal(state.streams[0].mediaId, mediaId);
    assert.equal(state.streams[0].id, `x-${mediaId}`);
  }
  assert.equal(h.calls.fetch.length, 0);
});

test('complete X metadata in another tab wins over a partial network record without a public request', async () => {
  const h = harness({ fetchImpl: async () => { throw new Error('Public X endpoint unavailable.'); } });
  await h.request('DETECT_X_MEDIA', { items: xMedia.extractXMedia(publicXPayload) }, xContent);
  const secondTab = { ...xContent, tab: { id: 4 } };
  await h.request('DETECT_STREAMS', { urls: [xMP4Small], title: 'Partial player observation' }, secondTab);
  const partial = (await h.request('GET_STATE', { tabId: 4 })).streams[0];
  assert.equal(partial.metadataComplete, false);
  assert.equal(partial.url, xMP4Small);
  const resolved = await h.request('RESOLVE_X_POST', { url: xPostUrl, tabId: 4 });
  assert.equal(resolved.ok, true, resolved.error);
  assert.equal(resolved.streams.length, 1);
  assert.equal(resolved.streams[0].metadataComplete, true);
  assert.equal(resolved.streams[0].url, xMP4Best);
  assert.equal(resolved.streams[0].mediaId, '1845922604009639947');
  assert.equal(h.calls.fetch.length, 0, 'A complete existing copy should avoid the unavailable public endpoint.');
});

test('a failed public lookup falls back to partial X metadata without declaring it complete', async () => {
  const h = harness({ fetchImpl: async () => jsonResponse({}) });
  await h.request('DETECT_STREAMS', { urls: [xHLS], title: 'Observed child playlist' }, xContent);
  for (let attempt = 0; attempt < 2; attempt++) {
    const resolved = await h.request('RESOLVE_X_POST', { url: xPostUrl, tabId: 3 });
    assert.equal(resolved.ok, true, resolved.error);
    assert.equal(resolved.streams.length, 1);
    assert.equal(resolved.streams[0].metadataComplete, false);
    assert.equal(resolved.streams[0].url, xHLS);
    assert.equal((await h.state()).streams[0].metadataComplete, false);
  }
  assert.equal(h.calls.fetch.length, 1, 'The recent failed lookup may be cached without changing metadata completeness.');
  assert.equal((await h.state()).jobs.length, 0);
});

test('a raw X MP4 observation without bitrate cannot downgrade a metadata-selected variant', async () => {
  const h = harness();
  await h.request('DETECT_X_MEDIA', { items: xMedia.extractXMedia(publicXPayload) }, xContent);
  await h.request('DETECT_STREAMS', { urls: [xMP4Best] }, xContent);
  const streams = (await h.state()).streams;
  assert.equal(streams.length, 1);
  assert.equal(streams[0].url, xMP4Best);
  assert.equal(streams[0].variants.find(variant => variant.url === xMP4Best).bitrate, 10368000);
  assert.equal(streams[0].variants.find(variant => variant.url === xMP4Small).bitrate, 832000);
});

test('opening the popup lazily resolves an empty active X post once without starting a job', async () => {
  const h = harness({
    fetchImpl: async () => jsonResponse(publicXPayload),
    getTab: async tabId => ({ id: tabId, url: xPostUrl, title: 'SpaceX on X' })
  });
  const first = await h.state();
  assert.equal(first.ok, true);
  assert.equal(first.streams.length, 1);
  assert.equal(first.streams[0].url, xMP4Best);
  assert.equal(first.jobs.length, 0);
  assert.equal(h.calls.fetch.length, 1);
  const second = await h.state();
  assert.equal(second.streams[0].id, first.streams[0].id);
  assert.equal(h.calls.fetch.length, 1);
  assert.equal(h.calls.offscreen.length, 0);
  assert.equal(h.calls.download.length, 0);
});

test('diagnostic reports may be written only by offscreen and read or cleared only by extension UI', async () => {
  const h = harness();
  const jobId = await h.createJob();
  const report = { schemaVersion: 1, jobId, status: 'converting', source: { format: 'hls', platform: 'web' }, events: [{ event: 'mux-start' }] };
  assert.equal((await h.request('JOB_DIAGNOSTIC', { jobId, report }, content)).ok, false);
  assert.equal((await h.request('JOB_DIAGNOSTIC', { jobId, report })).ok, false);
  assert.equal((await h.request('JOB_DIAGNOSTIC', { jobId, report }, offscreen)).ok, true);
  assert.equal((await h.request('GET_DIAGNOSTICS', {}, content)).ok, false);
  assert.equal((await h.request('GET_DIAGNOSTIC', { jobId }, content)).ok, false);
  assert.equal((await h.request('CLEAR_DIAGNOSTICS', {}, content)).ok, false);
  const listed = await h.request('GET_DIAGNOSTICS');
  assert.equal(listed.ok, true);
  assert.equal(listed.reports.length, 1);
  assert.equal(listed.reports[0].jobId, jobId);
  const preview = { id: extensionId, url: `${extensionOrigin}preview.html?id=one`, tab: { id: 92 } };
  assert.equal((await h.request('GET_DIAGNOSTIC', { jobId }, preview)).report.status, 'converting');
  assert.equal((await h.request('CLEAR_DIAGNOSTICS')).ok, true);
  assert.deepEqual((await h.request('GET_DIAGNOSTICS')).reports, []);
});

test('background diagnostic persistence removes nested video addresses and raw source metadata', async () => {
  const h = harness();
  const jobId = await h.createJob();
  await h.request('JOB_DIAGNOSTIC', { jobId, report: {
    schemaVersion: 1, status: 'error',
    source: { format: 'hls', platform: 'web', host: 'private.example', url: 'https://private.example/video' },
    events: [{ metadata: { url: 'https://private.example/manifest?token=secret', host: 'private.example', title: 'Private video title' } }],
    ffmpeg: { logs: [{ message: 'Unable to read https://private.example/segment.ts?token=secret' }] }
  } }, offscreen);
  const report = (await h.request('GET_DIAGNOSTIC', { jobId })).report;
  const text = JSON.stringify(report);
  assert.deepEqual(report.source, { format: 'hls', platform: 'web' });
  for (const forbidden of ['private.example', 'secret', 'Private video title', 'https://']) assert.ok(!text.includes(forbidden), forbidden);
  assert.match(text, /地址已隐藏/);
});

test('Chrome download completion marks a persisted report complete and late progress cannot revert it', async () => {
  const h = harness();
  const jobId = await h.createJob();
  await h.request('JOB_DIAGNOSTIC', { jobId, report: { schemaVersion: 1, status: 'saving', events: [] } }, offscreen);
  const saved = await h.request('SAVE_BLOB', blobRequest(jobId), offscreen);
  assert.equal(saved.ok, true);
  h.chrome.downloads.onChanged.listeners[0]({ id: saved.downloadId, state: { current: 'complete' } });
  assert.equal((await h.state()).jobs[0].status, 'complete');
  const completed = (await h.request('GET_DIAGNOSTIC', { jobId })).report;
  assert.equal(completed.status, 'complete');
  assert.ok(completed.completedAt);
  await h.request('JOB_DIAGNOSTIC', { jobId, report: { schemaVersion: 1, status: 'saving', events: [] } }, offscreen);
  assert.equal((await h.request('GET_DIAGNOSTIC', { jobId })).report.status, 'complete');
});

test('cancellation marks an existing report but creates no report for an unstarted queued job', async () => {
  const h = harness();
  const tracked = await h.createJob();
  const untracked = await h.createJob('https://cdn.example/queued.m3u8');
  await h.request('JOB_DIAGNOSTIC', { jobId: tracked, report: { schemaVersion: 1, status: 'preparing', events: [] } }, offscreen);
  await h.request('CANCEL_JOB', { jobId: tracked });
  await h.request('CANCEL_JOB', { jobId: untracked });
  const reports = (await h.request('GET_DIAGNOSTICS')).reports;
  assert.equal(reports.length, 1);
  assert.equal(reports[0].jobId, tracked);
  assert.equal(reports[0].status, 'cancelled');
  assert.ok(reports[0].completedAt);
});

const flushEvents = () => new Promise(resolve => setImmediate(resolve));
const emitCreated = (h, item) => h.chrome.downloads.onCreated.listeners[0](item);

test('one hundred simultaneous automatic saves retain every pending anchor until Chrome creates its download', async () => {
  let allDispatched;
  const dispatched = new Promise(resolve => { allDispatched = resolve; });
  let anchorCount = 0;
  const h = harness({ sendMessage(message) {
    if (message.type === 'SAVE_WITH_ANCHOR' && ++anchorCount === 100) allDispatched();
    return { ok: true };
  } });
  const jobIds = await Promise.all(Array.from({ length: 100 }, (_, index) => h.createJob(`https://cdn.example/save-${index}.m3u8`, false)));
  const blobs = jobIds.map((jobId, index) => ({ jobId, url: `blob:${extensionOrigin}save-${index}`, filename: 'test.mp4' }));
  const saving = blobs.map(data => h.request('SAVE_BLOB', data, offscreen));
  await dispatched;
  assert.equal(h.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY].length, 100);
  for (const [index, data] of blobs.entries()) emitCreated(h, { id: 1000 + index, url: data.url, state: 'in_progress' });
  const responses = await Promise.all(saving);
  for (const [index, response] of responses.entries()) {
    assert.equal(response.ok, true, response.error);
    assert.equal(response.downloadId, 1000 + index);
  }
  const { jobs } = await h.state();
  assert.equal(jobs.length, 100);
  for (const [index, jobId] of jobIds.entries()) assert.equal(jobs.find(job => job.id === jobId).downloadId, 1000 + index);
  assert.equal(h.calls.cancel.length, 0);
});

test('automatic MP4 saving registers before anchor dispatch and binds only its exact Blob', async () => {
  let h;
  h = harness({ sendMessage(message) {
    if (message.type === 'SAVE_WITH_ANCHOR') {
      const [registered] = h.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY];
      assert.equal(registered.url, message.url);
      assert.equal(registered.filename, 'safe_test.mp4');
      assert.equal(registered.jobId, message.jobId);
      queueMicrotask(() => emitCreated(h, { id: 81, url: message.url }));
    }
    return { ok: true };
  } });
  const jobId = await h.createJob(undefined, false);
  await h.request('RENAME_JOB', { jobId, title: 'safe:test' });
  const saved = await h.request('SAVE_BLOB', { ...blobRequest(jobId), filename: 'safe:test' }, offscreen);
  assert.deepEqual(saved, { ok: true, downloadId: 81 });
  assert.equal(h.calls.download.length, 0);
  assert.equal((await h.state()).jobs[0].downloadId, 81);
  h.chrome.downloads.onChanged.listeners[0]({ id: 81, state: { current: 'complete' } });
  await flushEvents();
  assert.equal((await h.state()).jobs[0].status, 'complete');
  assert.deepEqual(h.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY], []);
});

test('manual save retains Chrome saveAs semantics without registering a global filename listener', async () => {
  const h = harness();
  const jobId = await h.createJob(undefined, true);
  assert.equal((await h.request('SAVE_BLOB', blobRequest(jobId), offscreen)).ok, true);
  assert.equal(h.calls.download.length, 1);
  assert.equal(h.calls.download[0].saveAs, true);
  assert.equal(h.calls.download[0].filename, 'test.mp4');
  assert.equal(h.calls.offscreen.filter(item => item.type === 'SAVE_WITH_ANCHOR').length, 0);
  assert.equal(h.chrome.downloads.onDeterminingFilename, undefined);
  assert.equal((await h.request('PREPARE_DOWNLOAD_NAME', { url: blobRequest(jobId).url, filename: 'one.json' })).ok, false);
});

test('foreign creators, forged origins and unregistered Blob events never claim a job', async () => {
  const h = harness();
  const jobId = await h.createJob(undefined, false);
  await createDownloadNameStore(h.chrome.storage.session, { extensionId }).register(blobRequest(jobId).url, 'test.mp4', jobId);
  for (const item of [
    { id: 1, url: blobRequest(jobId).url, byExtensionId: 'another-extension' },
    { id: 2, url: 'https://example.test/file.mp4' },
    { id: 3, url: 'blob:chrome-extension://' + extensionId + '.evil/stable-file' },
    { id: 4, url: 'blob:' + extensionOrigin + 'unregistered' }
  ]) emitCreated(h, item);
  await flushEvents();
  assert.equal((await h.state()).jobs[0].downloadId, undefined);
  assert.equal(h.calls.cancel.length, 0);
  assert.equal(h.calls.download.length, 0);
});

test('a worker restart restores pending anchor association and a second download cannot replace its ID', async () => {
  const h = harness();
  const jobId = await h.createJob(undefined, false);
  const url = blobRequest(jobId).url;
  await createDownloadNameStore(h.chrome.storage.session, { extensionId }).register(url, 'test.mp4', jobId);
  const restarted = harness({ sessionStorage: h.chrome.storage.session });
  emitCreated(restarted, { id: 91, url });
  await flushEvents();
  assert.equal((await restarted.state()).jobs[0].downloadId, 91);
  emitCreated(restarted, { id: 92, url });
  await flushEvents();
  assert.equal((await restarted.state()).jobs[0].downloadId, 91);
  assert.equal(restarted.calls.cancel.length, 0);
});

test('an anchor that finishes before association is reconciled by downloads.search', async () => {
  const h = harness({ search: async id => [{ id, state: 'complete' }] });
  const jobId = await h.createJob(undefined, false);
  assert.equal((await h.request('SAVE_BLOB', blobRequest(jobId), offscreen)).ok, true);
  assert.equal((await h.state()).jobs[0].status, 'complete');
  await flushEvents();
  assert.deepEqual(h.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY], []);
});

test('cancelling an anchor before onCreated cancels its late download without reassociating the job', async () => {
  let started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const h = harness({ sendMessage(message) {
    if (message.type === 'SAVE_WITH_ANCHOR') started();
    return { ok: true };
  } });
  const jobId = await h.createJob(undefined, false);
  const saving = h.request('SAVE_BLOB', blobRequest(jobId), offscreen);
  await dispatched;
  await h.request('CANCEL_JOB', { jobId });
  assert.equal((await saving).ok, false);
  assert.equal(h.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY].length, 1);
  emitCreated(h, { id: 101, url: blobRequest(jobId).url });
  await flushEvents();
  assert.deepEqual(h.calls.cancel, [101]);
  assert.equal((await h.state()).jobs[0].status, 'cancelled');
  assert.equal((await h.state()).jobs[0].downloadId, undefined);
  assert.deepEqual(h.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY], []);
});

test('an anchor startup times out after 15 seconds and a late event is cancelled without retrying', async () => {
  let expire;
  let started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const h = harness({
    setTimeoutImpl(callback, ms) { assert.equal(ms, 15000); expire = callback; return 1; },
    clearTimeoutImpl() {},
    sendMessage(message) { if (message.type === 'SAVE_WITH_ANCHOR') started(); return { ok: true }; }
  });
  const jobId = await h.createJob(undefined, false);
  const saving = h.request('SAVE_BLOB', blobRequest(jobId), offscreen);
  await dispatched;
  expire();
  const saved = await saving;
  assert.equal(saved.ok, false);
  assert.match(saved.error, /保存未启动/);
  assert.equal((await h.state()).jobs[0].status, 'error');
  emitCreated(h, { id: 102, url: blobRequest(jobId).url });
  await flushEvents();
  assert.deepEqual(h.calls.cancel, [102]);
  assert.equal(h.calls.offscreen.filter(item => item.type === 'SAVE_WITH_ANCHOR').length, 1);
});

test('a rejected anchor startup removes the registration and releases the Blob', async () => {
  const h = harness({ sendMessage(message) {
    return message.type === 'SAVE_WITH_ANCHOR' ? { ok: false, error: 'Anchor unavailable' } : { ok: true };
  } });
  const jobId = await h.createJob(undefined, false);
  assert.equal((await h.request('SAVE_BLOB', blobRequest(jobId), offscreen)).ok, false);
  assert.deepEqual(h.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY], []);
  assert.equal((await h.state()).jobs[0].status, 'error');
  assert.ok(h.calls.offscreen.some(item => item.type === 'RELEASE_BLOB'));
});

test('the 15-second startup timeout also covers an offscreen acknowledgement that never arrives', async () => {
  let expire;
  let started;
  const dispatched = new Promise(resolve => { started = resolve; });
  const h = harness({
    setTimeoutImpl(callback) { expire = callback; return 1; }, clearTimeoutImpl() {},
    sendMessage(message) {
      if (message.type === 'SAVE_WITH_ANCHOR') { started(); return new Promise(() => {}); }
      return { ok: true };
    }
  });
  const jobId = await h.createJob(undefined, false);
  const saving = h.request('SAVE_BLOB', blobRequest(jobId), offscreen);
  await dispatched;
  expire();
  const result = await saving;
  assert.equal(result.ok, false);
  assert.match(result.error, /保存未启动/);
  assert.equal((await h.state()).jobs[0].status, 'error');
});

test('cancellation during anchor registration prevents any dispatch', async () => {
  const h = harness();
  const jobId = await h.createJob(undefined, false);
  const set = h.chrome.storage.session.set;
  let release;
  let started;
  const waiting = new Promise(resolve => { release = resolve; });
  const writing = new Promise(resolve => { started = resolve; });
  h.chrome.storage.session.set = async data => {
    if (data[DOWNLOAD_NAMES_STORAGE_KEY]?.length) { started(); await waiting; }
    return set(data);
  };
  const saving = h.request('SAVE_BLOB', blobRequest(jobId), offscreen);
  await writing;
  await h.request('CANCEL_JOB', { jobId });
  release();
  assert.equal((await saving).ok, false);
  assert.equal(h.calls.offscreen.filter(item => item.type === 'SAVE_WITH_ANCHOR').length, 0);
  assert.equal(h.calls.download.length, 0);
  assert.equal((await h.state()).jobs[0].status, 'cancelled');
  assert.deepEqual(h.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY], []);
});

test('deleting a finished record is idempotent and preserves saved files, Chrome history, and diagnostics', async () => {
  const h = harness();
  const jobId = await h.createJob();
  await h.request('JOB_DIAGNOSTIC', { jobId, report: { schemaVersion: 1, status: 'saving', events: [] } }, offscreen);
  await h.request('SAVE_BLOB', blobRequest(jobId), offscreen);
  h.chrome.downloads.onChanged.listeners[0]({ id: 72, state: { current: 'complete' } });
  await flushEvents();
  const cancelCount = h.calls.offscreen.filter(item => item.type === 'CANCEL_JOB').length;
  assert.equal((await h.request('DELETE_JOB', { jobId })).ok, true);
  assert.equal((await h.request('DELETE_JOB', { jobId })).ok, true);
  assert.deepEqual((await h.state()).jobs, []);
  assert.equal((await h.request('GET_DIAGNOSTIC', { jobId })).report.status, 'complete');
  assert.equal(h.calls.offscreen.filter(item => item.type === 'CANCEL_JOB').length, cancelCount);
  assert.deepEqual(h.calls.cancel, []);
  assert.deepEqual(h.calls.erase, []);
  assert.deepEqual(h.calls.removeFile, []);
});

test('content and offscreen senders cannot delete or clear task history', async () => {
  const h = harness();
  const jobId = await h.createJob();
  for (const sender of [content, offscreen, { ...popup, id: 'another-extension' }]) {
    assert.equal((await h.request('DELETE_JOB', { jobId }, sender)).ok, false);
    assert.equal((await h.request('CLEAR_JOBS', {}, sender)).ok, false);
  }
  assert.equal((await h.state()).jobs[0].id, jobId);
  assert.equal(h.calls.offscreen.filter(item => item.type === 'CANCEL_JOB').length, 0);
});

test('deleting an active task stops its engine and late updates or saves never recreate it', async () => {
  const h = harness();
  const jobId = await h.createJob();
  await h.request('JOB_UPDATE', { jobId, patch: { status: 'downloading' } }, offscreen);
  await h.request('JOB_DIAGNOSTIC', { jobId, report: { schemaVersion: 1, status: 'downloading', events: [] } }, offscreen);
  assert.equal((await h.request('DELETE_JOB', { jobId })).ok, true);
  assert.ok(h.calls.offscreen.some(item => item.type === 'CANCEL_JOB' && item.jobId === jobId));
  assert.ok(h.calls.offscreen.some(item => item.type === 'RELEASE_BLOB' && item.jobId === jobId));
  assert.equal((await h.request('JOB_UPDATE', { jobId, patch: { status: 'complete' } }, offscreen)).ok, true);
  assert.equal((await h.request('SAVE_BLOB', blobRequest(jobId), offscreen)).ok, false);
  assert.deepEqual((await h.state()).jobs, []);
  assert.equal(h.calls.download.length, 0);
  assert.equal((await h.request('GET_DIAGNOSTIC', { jobId })).report.status, 'cancelled');
});

for (const operation of ['DELETE_JOB', 'CLEAR_JOBS']) {
  test(`${operation} cancels a pending manual save when Chrome eventually returns its download ID`, async () => {
    let finish;
    let started;
    const downloading = new Promise(resolve => { started = resolve; });
    const h = harness({ download() { started(); return new Promise(resolve => { finish = resolve; }); } });
    const jobId = await h.createJob();
    const saving = h.request('SAVE_BLOB', blobRequest(jobId), offscreen);
    await downloading;
    assert.equal((await h.request(operation, { jobId })).ok, true);
    assert.deepEqual((await h.state()).jobs, []);
    finish(301);
    assert.equal((await saving).ok, true);
    assert.deepEqual(h.calls.cancel, [301]);
    assert.deepEqual((await h.state()).jobs, []);
    assert.deepEqual(h.calls.erase, []);
    assert.deepEqual(h.calls.removeFile, []);
  });

  test(`${operation} stops pending anchor saves and cancels their late onCreated event after worker restart`, async () => {
    let started;
    const dispatched = new Promise(resolve => { started = resolve; });
    const h = harness({ sendMessage(message) {
      if (message.type === 'SAVE_WITH_ANCHOR') started();
      return { ok: true };
    } });
    const jobId = await h.createJob(undefined, false);
    const saving = h.request('SAVE_BLOB', blobRequest(jobId), offscreen);
    await dispatched;
    await h.request(operation, { jobId });
    assert.equal((await saving).ok, false);
    assert.deepEqual((await h.state()).jobs, []);
    assert.equal(h.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY].length, 1);
    const restarted = harness({ sessionStorage: h.chrome.storage.session });
    emitCreated(restarted, { id: 302, url: blobRequest(jobId).url });
    await flushEvents();
    assert.deepEqual(restarted.calls.cancel, [302]);
    assert.deepEqual((await restarted.state()).jobs, []);
    assert.deepEqual(restarted.chrome.storage.session.values[DOWNLOAD_NAMES_STORAGE_KEY], []);
  });
}

test('clear removes one atomic snapshot and preserves new jobs started while cleanup is pending', async () => {
  let release;
  let started;
  const stopping = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const h = harness({ sendMessage(message) {
    if (message.type === 'CANCEL_JOB') { started(); return blocked; }
    return { ok: true };
  } });
  const old = await h.createJob();
  const clearing = h.request('CLEAR_JOBS');
  await stopping;
  const added = await h.createJob('https://cdn.example/new.m3u8');
  assert.deepEqual((await h.state()).jobs.map(item => item.id), [added]);
  release({ ok: true });
  assert.equal((await clearing).ok, true);
  assert.deepEqual((await h.state()).jobs.map(item => item.id), [added]);
  assert.deepEqual(h.calls.offscreen.filter(item => item.type === 'CANCEL_JOB').map(item => item.jobId), [old]);
});

test('clear stops every active queued or saving task but only removes terminal history and retains all diagnostics', async () => {
  const h = harness();
  const saving = await h.createJob();
  await h.request('SAVE_BLOB', blobRequest(saving), offscreen);
  const queued = await h.createJob('https://cdn.example/queued.m3u8');
  const finished = await h.createJob('https://cdn.example/finished.m3u8');
  await h.request('JOB_UPDATE', { jobId: finished, patch: { status: 'error', error: 'Fixture error' } }, offscreen);
  for (const jobId of [saving, queued, finished]) await h.request('JOB_DIAGNOSTIC', {
    jobId, report: { schemaVersion: 1, status: jobId === finished ? 'error' : 'preparing', events: [] }
  }, offscreen);
  assert.equal((await h.request('CLEAR_JOBS')).ok, true);
  assert.deepEqual((await h.state()).jobs, []);
  assert.deepEqual(h.calls.cancel, [72]);
  assert.deepEqual(h.calls.offscreen.filter(item => item.type === 'CANCEL_JOB').map(item => item.jobId).sort(), [saving, queued].sort());
  const reports = (await h.request('GET_DIAGNOSTICS')).reports;
  assert.equal(reports.length, 3);
  assert.equal(reports.find(item => item.jobId === finished).status, 'error');
  assert.equal(reports.find(item => item.jobId === queued).status, 'cancelled');
  assert.deepEqual(h.calls.erase, []);
  assert.deepEqual(h.calls.removeFile, []);
  assert.equal((await h.request('CLEAR_JOBS')).ok, true);
});

test('deleting during an engine handoff cannot restore the removed row on its eventual failure', async () => {
  let fail;
  let started;
  const handingOff = new Promise(resolve => { started = resolve; });
  const h = harness({ sendMessage(message) {
    if (message.type === 'RUN_JOB') { started(); return new Promise((_resolve, reject) => { fail = reject; }); }
    return { ok: true };
  } });
  const creating = h.request('START_DOWNLOAD', { url: 'https://cdn.example/handoff.m3u8', title: 'Fixture' });
  await handingOff;
  const jobId = (await h.state()).jobs[0].id;
  await h.request('DELETE_JOB', { jobId });
  fail(new Error('Handoff closed'));
  assert.equal((await creating).ok, false);
  assert.deepEqual((await h.state()).jobs, []);
  assert.ok(h.calls.offscreen.some(item => item.type === 'CANCEL_JOB' && item.jobId === jobId));
});

test('only trusted extension UI may rename a task', async () => {
  const h = harness();
  const jobId = await h.createJob();
  for (const sender of [content, offscreen, { ...popup, id: 'another-extension' }, { ...popup, url: `${extensionOrigin}untrusted.html` }]) {
    assert.equal((await h.request('RENAME_JOB', { jobId, title: 'Changed' }, sender)).ok, false);
  }
  assert.equal((await h.state()).jobs[0].title, 'test');
  const preview = { id: extensionId, url: `${extensionOrigin}preview.html?id=one`, tab: { id: 92 } };
  assert.deepEqual(await h.request('RENAME_JOB', { jobId, title: '新名称.mp4' }, preview), {
    ok: true, localFileRenamed: false, requiresLocalRename: false, title: '新名称', status: 'queued'
  });
  assert.equal((await h.state()).jobs[0].title, '新名称');
});

test('queued and converting tasks accept safe titles while empty or wholly invalid names are rejected', async () => {
  const h = harness();
  const jobId = await h.createJob();
  for (const status of ['queued', 'preparing', 'downloading', 'converting']) {
    await h.request('JOB_UPDATE', { jobId, patch: { status } }, offscreen);
    assert.equal((await h.request('RENAME_JOB', { jobId, title: `${status}:视频.mp4` })).ok, true);
    assert.equal((await h.state()).jobs[0].title, `${status}_视频`);
  }
  for (const title of [undefined, null, 0, '', '   ', '.mp4', '???', '../']) {
    const result = await h.request('RENAME_JOB', { jobId, title });
    assert.equal(result.ok, false);
    assert.match(result.error, /名称/);
  }
  assert.equal((await h.state()).jobs[0].title, 'converting_视频');
  await h.request('RENAME_JOB', { jobId, title: 'NUL.mp4' });
  assert.equal((await h.state()).jobs[0].title, '_NUL');
});

for (const saveAs of [true, false]) {
  test(`the latest renamed title controls ${saveAs ? 'manual' : 'automatic anchor'} SAVE_BLOB despite a stale offscreen filename`, async () => {
    const h = harness();
    const jobId = await h.createJob(undefined, saveAs);
    const engineCopy = h.calls.offscreen.find(item => item.type === 'RUN_JOB').job;
    assert.equal(engineCopy.title, 'test');
    await h.request('RENAME_JOB', { jobId, title: '最新视频名.mp4' });
    assert.equal((await h.request('SAVE_BLOB', { ...blobRequest(jobId), filename: 'stale-title.mp4' }, offscreen)).ok, true);
    if (saveAs) {
      assert.equal(h.calls.download[0].filename, '最新视频名.mp4');
      assert.equal(h.calls.download[0].saveAs, true);
    } else {
      assert.equal(h.calls.offscreen.find(item => item.type === 'SAVE_WITH_ANCHOR').filename, '最新视频名.mp4');
      assert.equal(h.calls.download.length, 0);
    }
    assert.equal(engineCopy.title, 'test', 'the engine snapshot remains stale, so background must choose the latest title');
    assert.equal((await h.request('RENAME_JOB', { jobId, title: 'Too late' })).ok, false);
    assert.equal((await h.state()).jobs[0].title, '最新视频名');
  });
}

test('failed and cancelled task renames update only the record and preserve independent diagnostics', async () => {
  for (const status of ['error', 'cancelled']) {
    const h = harness();
    const jobId = await h.createJob();
    await h.request('JOB_UPDATE', { jobId, patch: { status } }, offscreen);
    await h.request('JOB_DIAGNOSTIC', { jobId, report: { schemaVersion: 1, status, events: [] } }, offscreen);
    const diagnostic = (await h.request('GET_DIAGNOSTIC', { jobId })).report;
    const result = await h.request('RENAME_JOB', { jobId, title: 'Changed.mp4' });
    assert.deepEqual(result, { ok: true, localFileRenamed: false, requiresLocalRename: status === 'complete', title: 'Changed', status });
    assert.equal((await h.state()).jobs[0].title, 'Changed');
    assert.equal((await h.state()).jobs[0].status, status);
    assert.deepEqual((await h.request('GET_DIAGNOSTIC', { jobId })).report, diagnostic);
    assert.equal(h.calls.download.length, 0);
    assert.deepEqual(h.calls.cancel, []);
    assert.deepEqual(h.calls.erase, []);
    assert.deepEqual(h.calls.removeFile, []);
  }
});

test('a missing or concurrently deleted task cannot be recreated by renaming', async () => {
  for (const operation of ['DELETE_JOB', 'CLEAR_JOBS']) {
    const h = harness();
    assert.equal((await h.request('RENAME_JOB', { jobId: 'missing', title: 'Changed' })).ok, false);
    const jobId = await h.createJob();
    const [removed, renamed] = await Promise.all([
      h.request(operation, { jobId }), h.request('RENAME_JOB', { jobId, title: 'Changed' })
    ]);
    assert.equal(removed.ok, true);
    assert.equal(renamed.ok, false);
    assert.match(renamed.error, /不存在|删除/);
    assert.deepEqual((await h.state()).jobs, []);
  }
});

test('rename and save share one linear boundary for the actual file name', async () => {
  const before = harness();
  const jobId = await before.createJob();
  const [renamed, saved] = await Promise.all([
    before.request('RENAME_JOB', { jobId, title: 'Before saving' }),
    before.request('SAVE_BLOB', blobRequest(jobId), offscreen)
  ]);
  assert.equal(renamed.ok, true);
  assert.equal(saved.ok, true);
  assert.equal(before.calls.download[0].filename, 'Before saving.mp4');
  const after = harness();
  const otherId = await after.createJob();
  const [saving, rejected] = await Promise.all([
    after.request('SAVE_BLOB', blobRequest(otherId), offscreen),
    after.request('RENAME_JOB', { jobId: otherId, title: 'After saving' })
  ]);
  assert.equal(saving.ok, true);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /保存/);
  assert.equal(after.calls.download[0].filename, 'test.mp4');
});

async function webStream(h, { tabId = 3, title = 'Detected title', url = 'https://cdn.example/stream-name.m3u8' } = {}) {
  await h.request('DETECT_STREAMS', { urls: [url], title }, { ...content, tab: { id: tabId } });
  return (await h.request('GET_STATE', { tabId })).streams.find(entry => entry.url === url);
}

test('stream name edits are UI-only, preserve detected metadata, and explicitly allow clearing a custom title', async () => {
  const h = harness();
  const stream = await webStream(h);
  const data = { tabId: 3, streamId: stream.id, title: '自定义:名称.mp4' };
  for (const sender of [content, offscreen, { ...popup, id: 'another-extension' }]) {
    for (const type of ['RENAME_STREAM', 'USE_PAGE_TITLE', 'GET_PAGE_TITLE']) {
      assert.equal((await h.request(type, data, sender)).ok, false);
    }
  }
  const renamed = await h.request('RENAME_STREAM', data);
  assert.equal(renamed.ok, true);
  assert.equal(renamed.stream.title, 'Detected title');
  assert.equal(renamed.stream.customTitle, '自定义_名称');
  assert.equal(renamed.title, '自定义_名称');
  const cleared = await h.request('RENAME_STREAM', { ...data, title: '' });
  assert.equal(cleared.stream.customTitle, '');
  assert.equal(cleared.stream.title, 'Detected title');
  const restarted = harness({ sessionStorage: h.chrome.storage.session });
  assert.equal((await restarted.state()).streams[0].customTitle, '');
  assert.equal((await h.request('RENAME_STREAM', { ...data, tabId: 4 })).ok, false);
  assert.equal((await h.request('RENAME_STREAM', { ...data, title: '???' })).ok, false);
});

test('redetection, page-title events and rescans never overwrite a fixed custom stream title', async () => {
  const h = harness();
  const stream = await webStream(h);
  await h.request('RENAME_STREAM', { tabId: 3, streamId: stream.id, title: 'Fixed name' });
  await webStream(h, { title: 'Updated metadata' });
  h.chrome.tabs.onUpdated.listeners[0](3, { title: 'Changed tab title' }, { title: 'Changed tab title', url: content.url });
  await h.request('RESCAN', { tabId: 3 });
  await webStream(h, { title: 'Rescanned metadata' });
  const updated = (await h.state()).streams[0];
  assert.equal(updated.title, 'Rescanned metadata');
  assert.equal(updated.customTitle, 'Fixed name');
});

test('X metadata refreshes preserve local custom names and never copy a different tab custom name', async () => {
  const h = harness();
  const items = xMedia.extractXMedia(publicXPayload);
  await h.request('DETECT_X_MEDIA', { items }, xContent);
  const stream = (await h.state()).streams[0];
  await h.request('RENAME_STREAM', { tabId: 3, streamId: stream.id, title: 'Tab three' });
  const copy = await h.request('RESOLVE_X_POST', { tabId: 4, url: xPostUrl });
  assert.equal(Object.hasOwn(copy.streams[0], 'customTitle'), false);
  await h.request('RENAME_STREAM', { tabId: 4, streamId: copy.streams[0].id, title: 'Tab four' });
  const updated = xMedia.extractXMedia(publicXPayload);
  updated[0].title = 'New X metadata';
  await h.request('DETECT_X_MEDIA', { items: updated }, xContent);
  await h.request('RESOLVE_X_POST', { tabId: 4, url: xPostUrl });
  assert.equal((await h.state()).streams[0].customTitle, 'Tab three');
  assert.equal((await h.request('GET_STATE', { tabId: 4 })).streams[0].customTitle, 'Tab four');
});

test('GET_PAGE_TITLE and USE_PAGE_TITLE read the live main-frame DOM and store a safe fixed title', async () => {
  const h = harness({ executeScript: async () => [{ frameId: 0, result: '实际网页:标题.mp4' }] });
  const stream = await webStream(h, { title: 'Cached title' });
  assert.deepEqual(await h.request('GET_PAGE_TITLE', { tabId: 3 }), { ok: true, title: '实际网页_标题' });
  const selected = await h.request('USE_PAGE_TITLE', { tabId: 3, streamId: stream.id });
  assert.equal(selected.stream.customTitle, '实际网页_标题');
  assert.equal(selected.stream.title, 'Cached title');
  assert.deepEqual(copy(h.calls.scripts[0].target), { tabId: 3, frameIds: [0] });
  assert.match(h.calls.scripts[0].func.toString(), /document\.title/);
  for (const executeScript of [async () => [{ frameId: 0, result: '' }], async () => { throw new Error('Restricted page'); }]) {
    const failing = harness({ executeScript });
    const item = await webStream(failing);
    const result = await failing.request('USE_PAGE_TITLE', { tabId: 3, streamId: item.id });
    assert.equal(result.ok, false);
    assert.match(result.error, /网页.*标题|网页仍然打开/);
    assert.equal(Object.hasOwn((await failing.state()).streams[0], 'customTitle'), false);
  }
});

for (const removal of ['clear', 'close', 'navigate']) {
  test(`a pending page-title selection cannot restore a stream after ${removal}`, async () => {
    let finish;
    let started;
    const reading = new Promise(resolve => { started = resolve; });
    const h = harness({ executeScript() { started(); return new Promise(resolve => { finish = resolve; }); } });
    const stream = await webStream(h);
    const selecting = h.request('USE_PAGE_TITLE', { tabId: 3, streamId: stream.id });
    await reading;
    if (removal === 'clear') await h.request('CLEAR_STREAMS', { tabId: 3 });
    if (removal === 'close') h.chrome.tabs.onRemoved.listeners[0](3);
    if (removal === 'navigate') h.chrome.webRequest.onBeforeRequest.listeners[0]({ tabId: 3, type: 'main_frame', url: 'https://example.test/new-page' });
    await flushEvents();
    finish([{ frameId: 0, result: 'Late page title' }]);
    assert.equal((await selecting).ok, false);
    assert.deepEqual((await h.state()).streams, []);
  });
}

test('a pending public X lookup does not restore records after clearing the detected list', async () => {
  let finish;
  let started;
  const fetching = new Promise(resolve => { started = resolve; });
  const h = harness({ fetchImpl() { started(); return new Promise(resolve => { finish = resolve; }); } });
  const resolving = h.request('RESOLVE_X_POST', { tabId: 3, url: xPostUrl });
  await fetching;
  await h.request('CLEAR_STREAMS', { tabId: 3 });
  finish(jsonResponse(publicXPayload));
  assert.deepEqual((await resolving).streams, []);
  assert.deepEqual((await h.state()).streams, []);
});

test('download names come from the exact tab and stream custom title, including distinct jobs for the same URL', async () => {
  const h = harness();
  const first = await webStream(h, { tabId: 3, title: 'Detected first' });
  const second = await webStream(h, { tabId: 4, title: 'Detected second' });
  await h.request('RENAME_STREAM', { tabId: 3, streamId: first.id, title: 'First custom' });
  await h.request('RENAME_STREAM', { tabId: 4, streamId: second.id, title: 'Second custom' });
  const one = await h.request('START_DOWNLOAD', { tabId: 3, streamId: first.id, url: first.url, title: 'Stale popup title' });
  const two = await h.request('START_DOWNLOAD', { tabId: 4, streamId: second.id, url: second.url, title: 'Stale popup title' });
  assert.equal(one.ok, true);
  assert.equal(two.ok, true);
  assert.notEqual(one.jobId, two.jobId);
  const jobs = (await h.state()).jobs;
  assert.equal(jobs.find(job => job.id === one.jobId).title, 'First custom');
  assert.equal(jobs.find(job => job.id === two.jobId).title, 'Second custom');
  assert.equal((await h.request('START_DOWNLOAD', { tabId: 4, streamId: first.id, url: first.url })).ok, false);
  const manual = await h.request('START_DOWNLOAD', { tabId: 5, url: first.url });
  assert.equal((await h.state()).jobs.find(job => job.id === manual.jobId).title, '网页视频');
});

test('unnamed discovered sources require an explicit name while manual URL fallbacks stay unchanged', async () => {
  const h = harness();
  const stream = await webStream(h, { title: '视频源 2' });
  const options = { tabId: 3, streamId: stream.id, url: stream.url, title: 'Old popup fallback' };
  assert.match((await h.request('START_DOWNLOAD', options)).error, /填写文件名|网页标题/);
  await h.request('RENAME_STREAM', { tabId: 3, streamId: stream.id, title: 'Named' });
  await h.request('RENAME_STREAM', { tabId: 3, streamId: stream.id, title: '' });
  assert.match((await h.request('START_DOWNLOAD', options)).error, /填写文件名|网页标题/);
  assert.equal((await h.request('START_DOWNLOAD', { tabId: 3, url: stream.url, title: 'Explicit manual name' })).ok, true);
});

test('preview tickets use the latest local custom title or an authenticated snapshot after clearing the original page', async () => {
  const h = harness();
  const stream = await webStream(h);
  await h.request('RENAME_STREAM', { tabId: 3, streamId: stream.id, title: 'Preview snapshot' });
  await h.request('OPEN_PREVIEW', { tabId: 3, streamId: stream.id, url: stream.url, title: 'Stale title' });
  const [previewId, snapshot] = Object.entries(h.chrome.storage.session.values.previewSources)[0];
  assert.equal(snapshot.title, 'Preview snapshot');
  assert.equal(snapshot.streamId, stream.id);
  const options = { previewId, tabId: 3, streamId: stream.id, url: stream.url, title: 'Spoofed title' };
  await h.request('RENAME_STREAM', { tabId: 3, streamId: stream.id, title: 'Latest local name' });
  const latest = await h.request('START_DOWNLOAD', options);
  assert.equal((await h.state()).jobs.find(job => job.id === latest.jobId).title, 'Latest local name');
  await h.request('CLEAR_STREAMS', { tabId: 3 });
  assert.equal((await h.request('START_DOWNLOAD', { ...options, previewId: undefined })).ok, false);
  const restored = await h.request('START_DOWNLOAD', options);
  assert.equal(restored.ok, true);
  assert.equal((await h.state()).jobs.find(job => job.id === restored.jobId).title, 'Preview snapshot');
  assert.deepEqual((await h.state()).streams, []);
  for (const mismatch of [{ tabId: 4 }, { streamId: 'another' }, { url: 'https://cdn.example/another.m3u8' }, { previewId: 'unknown' }]) {
    assert.equal((await h.request('START_DOWNLOAD', { ...options, ...mismatch })).ok, false);
  }
});

test('an unnamed preview remains playable but its snapshot cannot manufacture a download name', async () => {
  const h = harness();
  const stream = await webStream(h, { title: '网页视频' });
  await h.request('RENAME_STREAM', { tabId: 3, streamId: stream.id, title: '' });
  assert.equal((await h.request('OPEN_PREVIEW', { tabId: 3, streamId: stream.id, url: stream.url })).ok, true);
  const [previewId, snapshot] = Object.entries(h.chrome.storage.session.values.previewSources)[0];
  assert.equal(snapshot.title, '');
  await h.request('CLEAR_STREAMS', { tabId: 3 });
  const result = await h.request('START_DOWNLOAD', { previewId, tabId: 3, streamId: stream.id, url: stream.url, title: 'Injected fallback' });
  assert.equal(result.ok, false);
  assert.match(result.error, /填写文件名|网页标题/);
});

test('clearing X streams suppresses lazy GET_STATE restoration until rescan or a new navigation', async () => {
  const h = harness({
    getTab: tabId => ({ id: tabId, url: xPostUrl, title: 'X page' }),
    fetchImpl: async () => jsonResponse(publicXPayload)
  });
  const first = (await h.state()).streams[0];
  assert.ok(first);
  await h.request('RENAME_STREAM', { tabId: 3, streamId: first.id, title: 'Discarded custom name' });
  await h.request('CLEAR_STREAMS', { tabId: 3 });
  for (let attempt = 0; attempt < 3; attempt++) assert.deepEqual((await h.state()).streams, []);
  assert.equal(h.calls.fetch.length, 1);
  await h.request('RESCAN', { tabId: 3 });
  const rescanned = (await h.state()).streams;
  assert.equal(rescanned.length, 1);
  assert.equal(Object.hasOwn(rescanned[0], 'customTitle'), false);
  await h.request('CLEAR_STREAMS', { tabId: 3 });
  h.chrome.webRequest.onBeforeRequest.listeners[0]({ tabId: 3, type: 'main_frame', url: xPostUrl });
  await flushEvents();
  assert.equal((await h.state()).streams.length, 1);
});

test('clearing the list does not block new X network detections or copy cleared custom names', async () => {
  const h = harness({ getTab: tabId => ({ id: tabId, url: xPostUrl, title: 'X page' }) });
  await h.request('DETECT_X_MEDIA', { items: xMedia.extractXMedia(publicXPayload) }, xContent);
  const stream = (await h.state()).streams[0];
  await h.request('RENAME_STREAM', { tabId: 3, streamId: stream.id, title: 'Discarded custom name' });
  await h.request('CLEAR_STREAMS', { tabId: 3 });
  assert.deepEqual((await h.state()).streams, []);
  h.chrome.webRequest.onBeforeRequest.listeners[0]({ tabId: 3, type: 'xmlhttprequest', url: xMP4Best });
  await flushEvents();
  const newlyDetected = (await h.state()).streams;
  assert.equal(newlyDetected.length, 1);
  assert.equal(Object.hasOwn(newlyDetected[0], 'customTitle'), false);
});

test('X list clearing survives service worker suspension and can still be rescanned after restarting', async () => {
  const getTab = tabId => ({ id: tabId, url: xPostUrl, title: 'X page' });
  const fetchImpl = async () => jsonResponse(publicXPayload);
  const original = harness({ getTab, fetchImpl });
  assert.equal((await original.state()).streams.length, 1);
  await original.request('CLEAR_STREAMS', { tabId: 3 });
  const restarted = harness({ getTab, fetchImpl, sessionStorage: original.chrome.storage.session });
  assert.deepEqual((await restarted.state()).streams, []);
  assert.equal(restarted.calls.fetch.length, 0, 'restarting the worker must not trigger a lookup after explicit clearing');
  await restarted.request('RESCAN', { tabId: 3 });
  assert.equal((await restarted.state()).streams.length, 1);
  assert.equal(restarted.calls.fetch.length, 1);
  const rescanned = harness({ getTab, fetchImpl, sessionStorage: restarted.chrome.storage.session });
  assert.equal((await rescanned.state()).streams.length, 1);
});

function completedHarness(options = {}) {
  const sessionStorage = storage();
  sessionStorage.values.jobs = [{ id: 'local-complete', status: 'complete', title: 'Old title', downloadId: 72, url: 'https://cdn.example/local.mp4' }];
  return harness({ sessionStorage, search: async () => [{ id: 72, state: 'complete', exists: true, filename: 'C:\\Downloads\\actual (1).mp4', fileSize: 1234 }], ...options });
}

test('completed rename returns an inline authorization ticket without opening a tab or changing the title before a native rename', async () => {
  let allowed = false;
  const renamedInputs = [];
  const h = completedHarness({ renameLocal: async (job, title) => {
    if (!allowed) throw new LocalDirectoryAuthorizationRequired();
    renamedInputs.push({ ...job, desiredTitle: title });
    return { path: `C:\\Downloads\\${title}.mp4`, size: 1234, lastModified: 7 };
  } });
  const result = await h.request('RENAME_JOB', { jobId: 'local-complete', title: '中文:新名.mp4' });
  assert.equal(result.ok, true);
  assert.equal(result.authorizationRequired, true);
  assert.equal(result.localFileRenamed, false);
  assert.equal(result.title, 'Old title');
  assert.equal((await h.state()).jobs[0].title, 'Old title');
  assert.deepEqual(h.calls.createdTabs, [], 'authorization must stay in the plugin popup');
  const id = result.authorizationId;
  assert.equal(typeof id, 'string');
  const sender = popup;
  const info = await h.request('GET_LOCAL_RENAME', { id }, sender);
  assert.deepEqual(result.authorization, Object.fromEntries(Object.entries(info).filter(([key]) => key !== 'ok')));
  assert.equal(info.filename, '中文_新名.mp4');
  assert.equal(info.currentFilename, 'actual (1).mp4');
  assert.equal(info.currentPath, 'C:\\Downloads\\actual (1).mp4');
  assert.equal(info.directoryPath, 'C:\\Downloads');
  assert.equal(info.size, 1234);
  assert.equal((await h.request('COMPLETE_LOCAL_RENAME', { id }, sender)).ok, false);
  assert.equal(h.calls.createdTabs.length, 0, 'completion must not open authorization pages');
  assert.equal((await h.state()).jobs[0].title, 'Old title');
  allowed = true;
  const completed = await h.request('COMPLETE_LOCAL_RENAME', { id }, sender);
  assert.equal(completed.localFileRenamed, true);
  assert.equal(completed.path, 'C:\\Downloads\\中文_新名.mp4');
  const job = (await h.state()).jobs[0];
  assert.equal(job.title, '中文_新名');
  assert.equal(job.localFilePath, completed.path);
  assert.equal(job.localFileSize, 1234);
  assert.equal(job.localFileLastModified, 7);
  assert.equal(renamedInputs.length, 1);
  assert.equal((await h.request('GET_LOCAL_RENAME', { id }, sender)).ok, false, 'successful tickets are single-use');
  assert.equal((await h.request('OPEN_DOWNLOAD', { downloadId: 72 })).ok, false, 'old Chrome download path cannot pretend to locate renamed files');
});

test('already authorized completed renames commit the native path and do not change diagnostics', async () => {
  const h = completedHarness({ renameLocal: async (_job, title) => ({ path: `C:\\Downloads\\${title}.mp4`, size: 1234, lastModified: 1 }) });
  await h.request('JOB_DIAGNOSTIC', { jobId: 'local-complete', report: { schemaVersion: 1, status: 'complete', events: [] } }, offscreen);
  const report = (await h.request('GET_DIAGNOSTIC', { jobId: 'local-complete' })).report;
  const result = await h.request('RENAME_JOB', { jobId: 'local-complete', title: 'Changed' });
  assert.equal(result.localFileRenamed, true);
  assert.equal((await h.state()).jobs[0].title, 'Changed');
  assert.equal(h.calls.createdTabs.length, 0);
  assert.deepEqual((await h.request('GET_DIAGNOSTIC', { jobId: 'local-complete' })).report, report);
  assert.equal(h.calls.download.length, 0);
  assert.deepEqual(h.calls.removeFile, []);
});

test('a failed native rename preserves the completed title and never creates a misleading success or new download', async () => {
  const h = completedHarness({ renameLocal: async () => { throw new Error('目标文件已存在'); } });
  const result = await h.request('RENAME_JOB', { jobId: 'local-complete', title: 'Changed' });
  assert.equal(result.ok, false);
  assert.equal((await h.state()).jobs[0].title, 'Old title');
  assert.equal(h.calls.createdTabs.length, 0);
  assert.equal(h.calls.download.length, 0);
});

test('untrusted senders and removed jobs cannot use local rename authorization tickets', async () => {
  const h = completedHarness();
  const result = await h.request('RENAME_JOB', { jobId: 'local-complete', title: 'Changed' });
  for (const sender of [content, offscreen, { ...popup, id: 'other-extension' }, { ...popup, url: `${extensionOrigin}local-rename.html?id=one` }, { ...popup, url: `${extensionOrigin}local-rename.html.evil?id=one` }]) {
    for (const type of ['GET_LOCAL_RENAME', 'COMPLETE_LOCAL_RENAME']) assert.equal((await h.request(type, { id: result.authorizationId }, sender)).ok, false);
  }
  await h.request('DELETE_JOB', { jobId: 'local-complete' });
  assert.equal((await h.request('COMPLETE_LOCAL_RENAME', { id: result.authorizationId })).ok, false);
  assert.deepEqual((await h.state()).jobs, []);
});

test('clear queued during an authorized native rename remains final and cannot resurrect the task', async () => {
  let finish;
  let started;
  const renaming = new Promise(resolve => { started = resolve; });
  const h = completedHarness({ renameLocal: () => { started(); return new Promise(resolve => { finish = resolve; }); } });
  const operation = h.request('RENAME_JOB', { jobId: 'local-complete', title: 'Changed' });
  await renaming;
  const cleared = h.request('CLEAR_JOBS');
  finish({ path: 'C:\\Downloads\\Changed.mp4', size: 1234 });
  assert.equal((await operation).localFileRenamed, true);
  assert.equal((await cleared).ok, true);
  assert.deepEqual((await h.state()).jobs, []);
});
