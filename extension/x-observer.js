import { extractXMedia } from './lib/x-media.js';

// Bundled as a MAIN-world content script. Only normalized video metadata crosses
// the page bridge: no API response bodies, request headers, cookies or tokens.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const reported = new Set();
const remembered = new Map();
const observedXHR = new WeakMap();

function allowedResponse(value) {
  try {
    const url = new URL(value, location.href);
    return ['x.com', 'www.x.com', 'api.x.com', 'twitter.com', 'www.twitter.com', 'api.twitter.com', 'cdn.syndication.twimg.com'].includes(url.hostname)
      && /\/(?:i\/api\/|graphql\/|1\.1\/|2\/|tweet-result)/.test(url.pathname);
  } catch { return false; }
}

function publish(payload) {
  const items = extractXMedia(payload).filter(item => {
    remembered.set(item.id, item);
    if (remembered.size > 25) remembered.delete(remembered.keys().next().value);
    const signature = JSON.stringify([item.id, item.url, item.variants]);
    if (reported.has(signature)) return false;
    reported.add(signature);
    return true;
  });
  if (reported.size > 500) reported.clear();
  if (items.length) window.postMessage({ source: 'liuguang-x-media-v1', items }, location.origin);
}

async function readResponse(response) {
  if (!allowedResponse(response.url) || !response.ok || !/json/i.test(response.headers.get('content-type') || '')) return;
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) return;
  const reader = response.clone().body?.getReader();
  if (!reader) return;
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); return; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    publish(JSON.parse(new TextDecoder().decode(bytes)));
  } catch { /* A failed observation must never change the page's request. */ }
  finally { reader.releaseLock(); }
}

if (!window.__liuguangXObserver) {
  Object.defineProperty(window, '__liuguangXObserver', { value: true });
  window.addEventListener('message', event => {
    if (event.source === window && event.origin === location.origin && event.data?.source === 'liuguang-x-scan-v1' && remembered.size) {
      window.postMessage({ source: 'liuguang-x-media-v1', items: [...remembered.values()] }, location.origin);
    }
  });
  const nativeFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = Reflect.apply(nativeFetch, this, args);
    promise.then(response => { void readResponse(response).catch(() => {}); }).catch(() => {});
    return promise;
  };
  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    observedXHR.set(this, String(url));
    return Reflect.apply(nativeOpen, this, [method, url, ...args]);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (allowedResponse(observedXHR.get(this))) this.addEventListener('load', () => {
      try {
        if (this.status < 200 || this.status >= 300 || !allowedResponse(this.responseURL)) return;
        if (this.responseType === 'json') publish(this.response);
        else if ((!this.responseType || this.responseType === 'text') && this.responseText.length <= MAX_RESPONSE_BYTES) publish(JSON.parse(this.responseText));
      } catch { /* Ignore non-JSON and aborted responses. */ }
    }, { once: true });
    return Reflect.apply(nativeSend, this, args);
  };
}
