import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { resolveXPost, xEmbedToken } from '../extension/lib/x-resolver.js';

const parser = (await readFile(new URL('../extension/lib/x-media.js', import.meta.url), 'utf8')).replace(/^export\s+/gm, '');
const observer = (await readFile(new URL('../extension/x-observer.js', import.meta.url), 'utf8')).replace(/^import[^\r\n]*;\s*$/gm, '');
const observerBundle = `(() => {\n${parser}\n${observer}\n})();`;
const api = 'https://x.com/i/api/graphql/query/TweetDetail';
const low = 'https://video.twimg.com/ext_tw_video/100/pu/vid/640x360/low.mp4';
const high = 'https://video.twimg.com/ext_tw_video/100/pu/vid/1280x720/high.mp4';
const hls = 'https://video.twimg.com/ext_tw_video/100/pu/pl/master.m3u8';
const payload = (id = '12345') => ({
  rest_id: id, __typename: 'Tweet',
  legacy: { id_str: id, full_text: 'X 视频正文', extended_entities: { media: [{
    id_str: '100', type: 'video', video_info: { variants: [
      { url: low, bitrate: 800000, content_type: 'video/mp4' },
      { url: high, bitrate: 2000000, content_type: 'video/mp4' },
      { url: hls, content_type: 'application/x-mpegURL' },
    ] },
  }] } },
  authorization: 'Bearer PRIVATE_AUTH', cookies: 'secret_cookie=PRIVATE_COOKIE', rawPrivateField: 'PRIVATE_JSON',
});

function observerHarness(nativeFetch = async () => undefined) {
  const messages = [];
  const listeners = [];
  class FakeXHR {
    constructor() { this.events = new Map(); this.status = 200; this.responseType = ''; }
    open(...args) { this.openArgs = args; return 'open-result'; }
    send(...args) { this.sendArgs = args; return 'send-result'; }
    addEventListener(name, callback, options = {}) {
      if (!this.events.has(name)) this.events.set(name, []);
      this.events.get(name).push({ callback, once: options.once });
    }
    load() {
      const callbacks = this.events.get('load') || [];
      this.events.set('load', callbacks.filter(entry => !entry.once));
      for (const { callback } of callbacks) callback.call(this);
    }
  }
  const window = {
    fetch: nativeFetch,
    postMessage(message, origin) { messages.push({ message: structuredClone(message), origin }); },
    addEventListener(name, callback) { listeners.push({ name, callback }); },
  };
  const context = vm.createContext({
    window, XMLHttpRequest: FakeXHR, location: { href: 'https://x.com/user/status/12345', origin: 'https://x.com' },
    URL, TextDecoder, Uint8Array, console,
  });
  const inject = () => vm.runInContext(observerBundle, context, { filename: 'x-observer.js' });
  inject();
  return {
    window, messages, listeners, FakeXHR, inject,
    rescan({ source = window, origin = 'https://x.com' } = {}) {
      for (const entry of listeners.filter(entry => entry.name === 'message')) {
        entry.callback({ source, origin, data: { source: 'liuguang-x-scan-v1' } });
      }
    },
  };
}

function jsonResponse(data, { url = api, status = 200, contentType = 'application/json', contentLength } = {}) {
  const result = new Response(JSON.stringify(data), {
    status, headers: { 'content-type': contentType, ...(contentLength ? { 'content-length': String(contentLength) } : {}) },
  });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}

async function waitUntil(predicate) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('observer did not finish processing the synthetic response');
}

test('MAIN fetch observer preserves exact fetch promise, response, arguments and body', async () => {
  const original = jsonResponse(payload());
  const originalPromise = Promise.resolve(original);
  const receiver = { name: 'original-this' };
  const options = { headers: { authorization: 'PRIVATE_REQUEST_HEADER' }, credentials: 'include' };
  let argumentsSeen;
  let thisSeen;
  const h = observerHarness(function (...args) { argumentsSeen = args; thisSeen = this; return originalPromise; });
  const returned = h.window.fetch.call(receiver, api, options);
  assert.equal(returned, originalPromise);
  assert.equal(await returned, original);
  assert.equal(argumentsSeen[0], api);
  assert.equal(argumentsSeen[1], options);
  assert.equal(thisSeen, receiver);
  await waitUntil(() => h.messages.length === 1);
  assert.equal(original.bodyUsed, false, 'observer must consume only a cloned body');
  assert.deepEqual(await original.json(), payload());
});

test('a response clone failure cannot alter fetch or create an unhandled page rejection', async context => {
  const original = jsonResponse(payload());
  let cloneCalls = 0;
  original.clone = () => { cloneCalls++; throw new TypeError('response body is already used'); };
  const promise = Promise.resolve(original);
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  context.after(() => process.removeListener('unhandledRejection', onUnhandled));
  const h = observerHarness(() => promise);
  assert.equal(h.window.fetch(api), promise);
  assert.equal(await promise, original);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cloneCalls, 1);
  assert.deepEqual(unhandled, []);
  assert.equal(h.messages.length, 0);
  assert.equal(original.bodyUsed, false);
  assert.deepEqual(await original.json(), payload());
});

test('MAIN observer publishes only normalized CDN video metadata rather than raw payload/authentication fields', async () => {
  const h = observerHarness(async () => jsonResponse(payload()));
  await h.window.fetch(api);
  await waitUntil(() => h.messages.length === 1);
  const [{ message, origin }] = h.messages;
  assert.equal(origin, 'https://x.com');
  assert.equal(message.source, 'liuguang-x-media-v1');
  assert.deepEqual(Object.keys(message).sort(), ['items', 'source']);
  assert.equal(message.items.length, 1);
  assert.equal(message.items[0].url, high);
  assert.equal(message.items[0].format, 'mp4');
  assert.equal(message.items[0].postUrl, 'https://x.com/i/status/12345');
  assert.deepEqual(message.items[0].variants.map(item => item.url), [high, low, hls]);
  assert.doesNotMatch(JSON.stringify(message), /PRIVATE_|authorization|cookies|video_info|extended_entities|rawPrivateField/);
});

test('only X API/syndication JSON responses are inspected; ordinary pages, other hosts and oversized responses stay untouched', async () => {
  let cloneCalls = 0;
  const responseList = [
    jsonResponse(payload(), { url: 'https://evil.example/i/api/graphql/TweetDetail' }),
    jsonResponse(payload(), { url: 'https://x.com/settings/profile' }),
    jsonResponse(payload(), { url: 'https://x.com/i/api/graphql/TweetDetail', contentType: 'text/html' }),
    jsonResponse(payload(), { url: api, contentLength: 8 * 1024 * 1024 + 1 }),
    jsonResponse(payload(), { url: api, status: 403 }),
  ];
  for (const item of responseList) {
    const nativeClone = item.clone.bind(item);
    item.clone = () => { cloneCalls++; return nativeClone(); };
  }
  const h = observerHarness(async () => responseList.shift());
  for (let index = 0; index < 5; index++) await h.window.fetch(api);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cloneCalls, 0);
  assert.equal(h.messages.length, 0);
  const syndication = jsonResponse(payload(), { url: 'https://cdn.syndication.twimg.com/tweet-result?id=12345' });
  responseList.push(syndication);
  await h.window.fetch(syndication.url);
  await waitUntil(() => h.messages.length === 1);
});

test('XHR observer preserves open/send behavior and extracts both json and text X responses', () => {
  const h = observerHarness();
  const xhr = new h.FakeXHR();
  assert.equal(xhr.open('GET', api, true), 'open-result');
  assert.deepEqual(xhr.openArgs, ['GET', api, true]);
  assert.equal(xhr.send('request-body'), 'send-result');
  assert.deepEqual(xhr.sendArgs, ['request-body']);
  xhr.responseType = 'json'; xhr.responseURL = api; xhr.response = payload(); xhr.load();
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].message.items[0].url, high);
  const text = new h.FakeXHR();
  text.open('POST', 'https://api.twitter.com/2/timeline'); text.send();
  text.responseType = 'text'; text.responseURL = 'https://api.twitter.com/2/timeline';
  text.responseText = JSON.stringify({ video: { variants: [{ src: 'https://pbs.twimg.com/tweet_video/second.mp4', type: 'video/mp4' }] } });
  text.load();
  assert.equal(h.messages.length, 2);
  const ignored = new h.FakeXHR();
  ignored.open('GET', 'https://other.example/graphql/query'); ignored.send();
  ignored.responseType = 'json'; ignored.responseURL = 'https://other.example/graphql/query'; ignored.response = payload('999'); ignored.load();
  assert.equal(h.messages.length, 2);
  assert.equal((ignored.events.get('load') || []).length, 0);
});

test('cached rescans replay media metadata and the sentinel prevents fetch/XHR double wrapping', async () => {
  const h = observerHarness(async () => jsonResponse(payload()));
  const fetchWrapper = h.window.fetch;
  const xhrOpenWrapper = h.FakeXHR.prototype.open;
  const xhrSendWrapper = h.FakeXHR.prototype.send;
  await h.window.fetch(api);
  await waitUntil(() => h.messages.length === 1);
  await h.window.fetch(api);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.messages.length, 1, 'normal repeated payloads must be deduplicated');
  h.rescan({ origin: 'https://other.example' });
  h.rescan({ source: {} });
  assert.equal(h.messages.length, 1);
  h.rescan();
  assert.equal(h.messages.length, 2);
  assert.deepEqual(h.messages[1], h.messages[0]);
  h.inject();
  assert.equal(h.window.fetch, fetchWrapper);
  assert.equal(h.FakeXHR.prototype.open, xhrOpenWrapper);
  assert.equal(h.FakeXHR.prototype.send, xhrSendWrapper);
  assert.equal(h.listeners.filter(item => item.name === 'message').length, 1);
  h.rescan();
  assert.equal(h.messages.length, 3);
});

test('X public embed token and resolver use the known public endpoint without credentials or authorization', async () => {
  const id = '1845922924315938922';
  assert.equal(xEmbedToken(id), '4h34yprw8d3');
  let requests = 0;
  const items = await resolveXPost(`https://x.com/example/status/${id}/video/1`, {
    fetchImpl: async (requestUrl, options) => {
      requests++;
      const endpoint = new URL(requestUrl);
      assert.equal(endpoint.origin, 'https://cdn.syndication.twimg.com');
      assert.equal(endpoint.pathname, '/tweet-result');
      assert.equal(endpoint.searchParams.get('id'), id);
      assert.equal(endpoint.searchParams.get('token'), '4h34yprw8d3');
      assert.equal(endpoint.searchParams.get('lang'), 'en');
      assert.equal(options.credentials, 'omit');
      assert.deepEqual(options.headers, {});
      return jsonResponse(payload(id), { url: requestUrl });
    },
  });
  assert.equal(requests, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].postId, id);
  assert.equal(items[0].postUrl, `https://x.com/i/status/${id}`);
  assert.equal(items[0].url, high);
});

test('invalid post links fail before any request and inaccessible posts preserve an actionable page-playback fallback', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; return jsonResponse({}, { status: 403 }); };
  for (const link of [
    'https://x.com/home', 'https://x.com/user/status/invalid', 'https://evil.example/user/status/123',
    'https://user:password@x.com/user/status/123', 'javascript:alert(1)',
  ]) await assert.rejects(resolveXPost(link, { fetchImpl }), /完整的 X 视频帖子链接/);
  assert.equal(requests, 0);
  await assert.rejects(resolveXPost('https://x.com/user/status/123', { fetchImpl }), /重新检测.*受保护/);
  assert.equal(requests, 1);
});

test('resolver refuses a response containing only another quoted post video', async () => {
  await assert.rejects(resolveXPost('https://x.com/user/status/123', {
    fetchImpl: async requestUrl => jsonResponse(payload('456'), { url: requestUrl }),
  }), /暂时无法.*X 视频/);
});
