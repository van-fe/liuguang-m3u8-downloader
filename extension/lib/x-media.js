/** Extract public media URLs already present in X/Twitter page response data. */
const PAGE_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const MAX_NODES = 50000;
const MAX_DEPTH = 60;
const MAX_RESULTS = 25;
const MAX_CANDIDATES = 256;
const MAX_VARIANTS = 100;

function parsedUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  try {
    const url = new URL(value);
    return url.username || url.password || url.port ? null : url;
  } catch { return null; }
}

export function isXPageUrl(value) {
  const url = parsedUrl(value);
  return Boolean(url && ['http:', 'https:'].includes(url.protocol) && PAGE_HOSTS.has(url.hostname));
}

function postId(value) {
  return typeof value === 'string' && /^\d{1,25}$/.test(value) ? value : null;
}

export function getXPostId(value) {
  if (!isXPageUrl(value)) return null;
  const match = /\/status(?:es)?\/(\d{1,25})(?:\/|$)/i.exec(new URL(value).pathname);
  return match ? match[1] : null;
}

export function isXMediaUrl(value) {
  const url = parsedUrl(value);
  if (!url || url.protocol !== 'https:') return false;
  if (url.hostname === 'video.twimg.com') return /\.(?:mp4|m3u8)$/i.test(url.pathname);
  return url.hostname === 'pbs.twimg.com' && url.pathname.startsWith('/tweet_video/') && /\.mp4$/i.test(url.pathname);
}

function object(value) { return value !== null && typeof value === 'object'; }
function text(value) {
  if (typeof value !== 'string') return '';
  let result = '';
  let count = 0;
  for (const character of value.replace(/\s+/g, ' ').trim()) {
    if (count++ === 120) break;
    result += character;
  }
  return result;
}

function positive(value) {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : 0;
  return Number.isFinite(number) && number > 0 && number <= 1e12 ? number : 0;
}

function normalizeVariant(value) {
  if (!object(value)) return null;
  const source = typeof value.url === 'string' ? value.url : value.src;
  if (!isXMediaUrl(source)) return null;
  const url = new URL(source);
  const dimensions = /\/(\d{1,6})x(\d{1,6})(?:\/|$)/i.exec(url.pathname);
  return {
    url: url.href,
    type: /\.mp4$/i.test(url.pathname) ? 'mp4' : 'hls',
    bitrate: positive(value.bitrate ?? value.bit_rate ?? value.bitRate),
    width: positive(value.width ?? value.w ?? value.resolution?.width) || Number(dimensions?.[1] || 0),
    height: positive(value.height ?? value.h ?? value.resolution?.height) || Number(dimensions?.[2] || 0),
  };
}

function compareVariants(left, right) {
  return Number(right.type === 'mp4') - Number(left.type === 'mp4')
    || right.bitrate - left.bitrate
    || right.width * right.height - left.width * left.height;
}

function normalizeVariants(variants) {
  if (!Array.isArray(variants)) return [];
  const unique = new Map();
  for (const value of variants.slice(0, MAX_VARIANTS)) {
    const variant = normalizeVariant(value);
    if (!variant) continue;
    const previous = unique.get(variant.url);
    if (!previous || compareVariants(variant, previous) < 0) unique.set(variant.url, variant);
  }
  return [...unique.values()].sort(compareVariants);
}

/** Accepts normalized variants or X's raw url/src and bitrate/bit_rate objects. */
export function selectXVariant(variants) { return normalizeVariants(variants)[0] || null; }

function looksLikeTweet(value) {
  if (!object(value)) return false;
  if (value.__typename === 'User') return false;
  if (value.__typename === 'Tweet') return true;
  if (typeof value.full_text === 'string') return true;
  if (object(value.legacy) && (typeof value.legacy.full_text === 'string' || value.legacy.extended_entities || Array.isArray(value.legacy.entities?.media))) return true;
  return typeof value.text === 'string' && Boolean(postId(value.id_str) || postId(value.id) || value.mediaDetails || value.extended_entities);
}

function tweetContext(value, inherited, fallbackId) {
  if (!looksLikeTweet(value) && !fallbackId) return inherited;
  const id = postId(value.rest_id) || postId(value.legacy?.id_str) || postId(value.id_str) || postId(value.id) || fallbackId || inherited.postId;
  return { postId: id || null, title: text(value.note_tweet?.note_tweet_results?.result?.text || value.legacy?.full_text || value.full_text || value.text) || inherited.title };
}

function mediaId(value) {
  const id = value?.media_key || value?.id_str || value?.id;
  return (typeof id === 'string' || typeof id === 'number') && /^[\w-]{1,100}$/.test(String(id)) ? String(id) : null;
}

function fallbackId(url) {
  const path = new URL(url).pathname;
  const known = /\/(?:ext_tw_video|amplify_video|tweet_video)\/([\w-]+)/.exec(path);
  if (known) return known[1];
  let hash = 2166136261;
  for (let index = 0; index < url.length; index++) hash = Math.imul(hash ^ url.charCodeAt(index), 16777619);
  return `media-${(hash >>> 0).toString(16)}`;
}

/**
 * Parse GraphQL, legacy tweet maps, API v2 includes, and syndication payloads.
 * Traversal and retained candidates are bounded; repeated/circular objects are
 * skipped. No requests, page evaluation, or private account data are performed.
 */
export function extractXMedia(payload) {
  if (typeof payload === 'string') {
    if (payload.length > 8 * 1024 * 1024) return [];
    try { payload = JSON.parse(payload); } catch { return []; }
  }
  if (!object(payload)) return [];
  const stack = [{ value: payload, context: { postId: null, title: '' }, key: '', depth: 0, fallback: null }];
  const visited = new WeakSet();
  const consumed = new WeakSet();
  const candidates = [];
  const tweets = new Map();
  const mediaOwners = new Map();
  let count = 0;

  while (stack.length && count++ < MAX_NODES) {
    const { value, context: inherited, key, depth, fallback } = stack.pop();
    if (!object(value) || visited.has(value) || depth > MAX_DEPTH) continue;
    visited.add(value);
    const context = tweetContext(value, inherited, fallback);
    if (context.postId && (looksLikeTweet(value) || fallback)) {
      const previous = tweets.get(context.postId);
      tweets.set(context.postId, context.title ? context : previous || context);
      const keys = value.attachments?.media_keys;
      if (Array.isArray(keys)) for (const mediaKey of keys.slice(0, 100)) if (typeof mediaKey === 'string') mediaOwners.set(mediaKey, context);
    }

    if (!consumed.has(value) && candidates.length < MAX_CANDIDATES) {
      let raw;
      let candidateId = null;
      if (Array.isArray(value.video_info?.variants)) {
        raw = value.video_info.variants;
        consumed.add(value.video_info);
        candidateId = mediaId(value);
      } else if (Array.isArray(value.video?.variants)) {
        raw = value.video.variants;
        consumed.add(value.video);
        candidateId = looksLikeTweet(value) ? mediaId(value.video) : mediaId(value);
      } else if (Array.isArray(value.variants)) {
        raw = value.variants;
        candidateId = mediaId(value);
      }
      if (raw) {
        const variants = normalizeVariants(raw);
        if (variants.length) candidates.push({ context, id: candidateId, mediaKey: value.media_key, variants, title: text(value.alt_text) });
      }
    }

    const remaining = MAX_NODES - count - stack.length;
    if (remaining <= 0) continue;
    if (Array.isArray(value)) {
      for (let index = Math.min(value.length, remaining) - 1; index >= 0; index--) {
        stack.push({ value: value[index], context, key: String(index), depth: depth + 1, fallback: null });
      }
    } else {
      const keys = Object.keys(value).slice(0, remaining);
      for (let index = keys.length - 1; index >= 0; index--) {
        const childKey = keys[index];
        stack.push({ value: value[childKey], context, key: childKey, depth: depth + 1, fallback: key === 'tweets' ? postId(childKey) : null });
      }
    }
  }

  const uniqueTweet = tweets.size === 1 ? tweets.values().next().value : null;
  const groups = [];
  const urls = new Map();
  const identities = new Map();
  for (const candidate of candidates) {
    const context = candidate.context.postId ? candidate.context : mediaOwners.get(candidate.mediaKey) || uniqueTweet || candidate.context;
    const owner = context.postId || '';
    const identity = candidate.id ? `${owner}|${candidate.id}` : null;
    const matches = new Set(candidate.variants.map(variant => urls.get(`${owner}|${variant.url}`)).filter(Boolean));
    if (identity && identities.has(identity)) matches.add(identities.get(identity));
    let group = matches.values().next().value;
    if (!group) {
      group = { id: candidate.id, context, variants: [], title: candidate.title, removed: false };
      groups.push(group);
    }
    for (const other of matches) {
      if (other === group || other.removed) continue;
      group.variants.push(...other.variants);
      other.removed = true;
      for (const [key, entry] of identities) if (entry === other) identities.set(key, group);
    }
    if (!group.id && candidate.id) group.id = candidate.id;
    if (!group.context.title && context.title) group.context = context;
    group.variants = normalizeVariants([...group.variants, ...candidate.variants]);
    for (const variant of group.variants) urls.set(`${owner}|${variant.url}`, group);
    if (identity) identities.set(identity, group);
  }
  return groups.filter(group => !group.removed).slice(0, MAX_RESULTS).map(group => {
    const selected = group.variants[0];
    const id = group.context.postId;
    return {
      id: group.id || fallbackId(selected.url),
      postId: id,
      postUrl: id ? `https://x.com/i/status/${id}` : null,
      title: group.context.title || group.title || 'X 视频',
      variants: group.variants,
      url: selected.url,
      format: selected.type,
    };
  });
}
