import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import * as xMedia from '../extension/lib/x-media.js';
import { resolveXPost } from '../extension/lib/x-resolver.js';
import { createDiagnosticStore } from '../extension/lib/diagnostic-store.js';
import { createDownloadNameStore, isOwnDownloadBlob, sanitizeDownloadName } from '../extension/lib/download-names.js';
import { getStreamTitle } from '../extension/lib/stream-names.js';

const contentSource = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
const backgroundSource = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'))
  .replace(/^import[^\r\n]*$/gm, '');
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const extensionOrigin = `chrome-extension://${extensionId}/`;
const permalink = 'https://hlsjs.video-dev.org/demo/?src=https%3A%2F%2Ftest-streams.mux.dev%2Fx36xhzz%2Fx36xhzz.m3u8&demoConfig=sample';
const pathPlaylist = 'https://cdn.example/master.m3u8?token=123';
const encodedPlaylist = 'https://cdn.example/master%2Em3u8?token=123';
const slashPlaylist = 'https://cdn.example/stream.m3u8/index?token=123';
const fragmentLink = 'https://player.example/watch#https://cdn.example/master.m3u8';
const htmlQueryLink = 'https://player.example/watch?src=https://cdn.example/master.m3u8';
const wrongSuffix = 'https://cdn.example/master.m3u8.ts?token=123';

function event() {
  const listeners = [];
  return { listeners, addListener: callback => listeners.push(callback) };
}

function contentHarness(resources, links = [], { pageUrl = permalink, withContext = false } = {}) {
  const messages = [];
  const windowListeners = new Map();
  const windowMessages = [];
  const window = {
    addEventListener(type, callback) { windowListeners.set(type, callback); },
    postMessage(message, origin) { windowMessages.push({ message: structuredClone(message), origin }); }
  };
  const context = {
    URL, location: new URL(pageUrl), window,
    document: {
      title: 'HLS demo',
      querySelectorAll: () => links.map(href => ({ href, getAttribute: () => null })),
      addEventListener() {},
    },
    performance: { getEntriesByType: () => resources.map(name => ({ name })) },
    PerformanceObserver: class { observe() {} },
    MutationObserver: class { observe() {} },
    chrome: { runtime: {
      onMessage: event(),
      async sendMessage(message) { messages.push(structuredClone(message)); return { ok: true }; },
    } },
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(contentSource, context, { filename: 'content.js' });
  return withContext ? {
    messages, context, window, windowMessages,
    emitMessage(event) { windowListeners.get('message')?.(event); }
  } : messages;
}

function backgroundHarness() {
  const values = {};
  const storage = {
    async get(keys) {
      const names = Array.isArray(keys) ? keys : [keys];
      return structuredClone(Object.fromEntries(names.filter(key => key in values).map(key => [key, values[key]])));
    },
    async set(data) { Object.assign(values, structuredClone(data)); },
  };
  const chrome = {
    runtime: {
      id: extensionId, getURL: name => `${extensionOrigin}${name}`,
      getContexts: async () => [], onMessage: event(),
    },
    storage: { local: storage, session: storage },
    downloads: { onChanged: event(), onCreated: event() },
    webRequest: { onBeforeRequest: event(), onHeadersReceived: event() },
    tabs: { onUpdated: event(), onRemoved: event(), async get(tabId) { return { id: tabId, url: permalink, title: 'HLS demo' }; } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
  };
  vm.runInNewContext(backgroundSource, { ...xMedia, resolveXPost, createDiagnosticStore, createDownloadNameStore, isOwnDownloadBlob, sanitizeDownloadName, getStreamTitle, chrome, URL, crypto: webcrypto, console }, { filename: 'background.js' });
  return {
    request(details) { chrome.webRequest.onBeforeRequest.listeners[0]({ tabId: 3, type: 'xmlhttprequest', ...details }); },
    headers(details) { chrome.webRequest.onHeadersReceived.listeners[0]({ tabId: 3, ...details }); },
    state: () => new Promise(resolve => chrome.runtime.onMessage.listeners[0](
      { target: 'background', type: 'GET_STATE', tabId: 3 },
      { id: extensionId, url: `${extensionOrigin}popup.html` },
      value => resolve(structuredClone(value)),
    )),
  };
}

test('content detection checks the URL path and ignores player permalinks that contain a manifest in their query or fragment', () => {
  const messages = contentHarness(
    [permalink, htmlQueryLink, fragmentLink, wrongSuffix, pathPlaylist, encodedPlaylist],
    [permalink, slashPlaylist, '/video/720.m3u8?auth=ok'],
  );
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].urls.sort(), [
    pathPlaylist, encodedPlaylist, slashPlaylist, 'https://hlsjs.video-dev.org/video/720.m3u8?auth=ok',
  ].sort());
});

test('background request detection ignores HTML query permalinks while preserving playlist paths and query tokens', async () => {
  const h = backgroundHarness();
  h.request({ url: permalink, type: 'main_frame' });
  for (const url of [htmlQueryLink, fragmentLink, wrongSuffix, pathPlaylist, encodedPlaylist, slashPlaylist]) h.request({ url });
  const state = await h.state();
  assert.equal(state.ok, true);
  assert.deepEqual(state.streams.map(stream => stream.url).sort(), [pathPlaylist, encodedPlaylist, slashPlaylist].sort());
});

test('MIME detection still captures extensionless HLS endpoints and ignores HTML demo responses', async () => {
  const h = backgroundHarness();
  h.headers({ url: permalink, responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }] });
  h.headers({ url: 'https://cdn.example/manifest?token=123', responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl; charset=utf-8' }] });
  h.headers({ url: 'https://cdn.example/audio', responseHeaders: [{ name: 'content-type', value: 'audio/x-mpegurl' }] });
  const state = await h.state();
  assert.deepEqual(state.streams.map(stream => stream.url).sort(), [
    'https://cdn.example/manifest?token=123', 'https://cdn.example/audio',
  ].sort());
});

test('background detects X CDN MP4 requests while ignoring unrelated MP4 resources', async () => {
  const h = backgroundHarness();
  const xMP4 = 'https://video.twimg.com/ext_tw_video/1845922604009639947/pu/vid/avc1/1920x1080/video.mp4?tag=14';
  h.request({ url: 'https://cdn.example/video.mp4' });
  h.request({ url: 'https://video.twimg.com.attacker.example/video.mp4' });
  h.request({ url: xMP4 });
  const state = await h.state();
  assert.equal(state.streams.length, 1);
  assert.equal(state.streams[0].url, xMP4);
  assert.equal(state.streams[0].format, 'mp4');
});

test('X page bridge forwards only same-window same-origin normalized metadata messages', () => {
  const pageUrl = 'https://x.com/SpaceX/status/1845922924315938922';
  const h = contentHarness([], [], { pageUrl, withContext: true });
  const items = [{ id: 'media-1', variants: [{ url: 'https://video.twimg.com/ext_tw_video/1/video.mp4', type: 'mp4' }] }];
  const goodEvent = { source: h.window, origin: 'https://x.com', data: { source: 'liuguang-x-media-v1', items } };
  h.emitMessage({ ...goodEvent, source: {} });
  h.emitMessage({ ...goodEvent, origin: 'https://attacker.example' });
  h.emitMessage({ ...goodEvent, data: { source: 'other-extension', items } });
  h.emitMessage({ ...goodEvent, data: { source: 'liuguang-x-media-v1', items: 'invalid' } });
  assert.equal(h.messages.filter(message => message.type === 'DETECT_X_MEDIA').length, 0);
  h.emitMessage(goodEvent);
  const forwarded = h.messages.filter(message => message.type === 'DETECT_X_MEDIA');
  assert.equal(forwarded.length, 1);
  assert.deepEqual(forwarded[0].items, items);
  assert.ok(h.messages.some(message => message.type === 'DETECT_X_POST' && message.url === pageUrl));
  assert.ok(h.windowMessages.some(({ message, origin }) => message.source === 'liuguang-x-scan-v1' && origin === 'https://x.com'));
});

test('ordinary pages do not enable the X metadata bridge or public post resolver', () => {
  const h = contentHarness([], [], { pageUrl: 'https://x.com.attacker.example/user/status/123', withContext: true });
  h.emitMessage({ source: h.window, origin: 'https://x.com.attacker.example', data: { source: 'liuguang-x-media-v1', items: [{ id: 'spoof' }] } });
  assert.deepEqual(h.messages, []);
  assert.deepEqual(h.windowMessages, []);
});
