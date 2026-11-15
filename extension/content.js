(() => {
  if (globalThis.__liuguangDetector) {
    globalThis.__liuguangDetector.scan();
    return;
  }

  const sent = new Set();
  let timer;
  let lastXPost;
  const xPage = ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'].includes(location.hostname);
  if (xPage) {
    window.addEventListener('message', event => {
      if (event.source !== window || event.origin !== location.origin || event.data?.source !== 'liuguang-x-media-v1' || !Array.isArray(event.data.items)) return;
      chrome.runtime.sendMessage({ target: 'background', type: 'DETECT_X_MEDIA', items: event.data.items.slice(0, 25) }).catch(() => {});
    });
  }
  const isPlaylist = (value) => {
    try {
      const url = new URL(value, location.href);
      let pathname = url.pathname;
      try { pathname = decodeURIComponent(pathname); } catch { /* Match the original path if its escaping is malformed. */ }
      return /^(https?):$/.test(url.protocol) && /\.m3u8(?:$|\/)/i.test(pathname);
    } catch {
      return false;
    }
  };

  function report(values, force = false) {
    const urls = [...new Set(values.filter(isPlaylist).map((url) => new URL(url, location.href).href))]
      .filter((url) => force || !sent.has(url)).slice(0, 80);
    if (!urls.length) return;
    for (const url of urls) sent.add(url);
    if (sent.size > 400) sent.clear();
    chrome.runtime.sendMessage({
      target: 'background', type: 'DETECT_STREAMS', urls,
      title: document.title, pageUrl: location.href
    }).catch(() => {});
  }

  function scan(force = false) {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    document.querySelectorAll('video, audio, source, a[href]').forEach((element) => {
      urls.push(element.currentSrc, element.src, element.href, element.getAttribute('src'));
    });
    report(urls.filter(Boolean), force);
    if (xPage) {
      window.postMessage({ source: 'liuguang-x-scan-v1' }, location.origin);
      const postId = /\/status\/(\d+)(?:\/|$)/.exec(location.pathname)?.[1];
      if (postId && (force || postId !== lastXPost)) {
        lastXPost = postId;
        chrome.runtime.sendMessage({ target: 'background', type: 'DETECT_X_POST', url: location.href }).catch(() => {});
      }
    }
  }

  globalThis.__liuguangDetector = { scan: () => scan(true) };
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'SCAN_STREAMS') return;
    scan(true);
    sendResponse({ ok: true });
  });

  try {
    new PerformanceObserver((list) => report(list.getEntries().map((entry) => entry.name)))
      .observe({ type: 'resource', buffered: true });
  } catch { /* Older embedded frames still have DOM and webRequest detection. */ }

  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => scan(), 500);
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });

  document.addEventListener('loadedmetadata', () => scan(), true);
  document.addEventListener('play', () => scan(), true);
  document.addEventListener('DOMContentLoaded', () => scan(), { once: true });
  scan();
})();
