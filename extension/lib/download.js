import { parsePlaylist, chooseVariant } from './hls.js';
import { requestToSink, createAesCbcDecryptTransform } from './network.js';
import { createMediaSanitizeTransform } from './media-sanitize.js';

export function assertHttpUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('请使用有效的 HTTP 或 HTTPS 视频地址');
  }
  return url.href;
}

export function sequenceIV(sequence) {
  const iv = new Uint8Array(16);
  let value = BigInt(sequence);
  for (let i = 15; i >= 0; i--) { iv[i] = Number(value & 255n); value >>= 8n; }
  return iv;
}

function checkAbort(signal) { signal?.throwIfAborted(); }

async function pause(ms, signal) {
  checkAbort(signal);
  await new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Fetch within the extension origin so Chrome host permissions apply. */
export async function requestBytes(url, { signal, range, fetchImpl = fetch, maxBytes = Infinity, onChunk, onRetry, retries = 3, credentials = 'include' } = {}) {
  assertHttpUrl(url);
  const retryLimit = Math.max(0, Math.min(10, Number.isInteger(retries) ? retries : 3));
  for (let attempt = 0; attempt <= retryLimit; attempt++) {
    checkAbort(signal);
    const timeout = new AbortController();
    const abort = () => timeout.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => timeout.abort(new Error('网络请求超时')), 45000);
    let response;
    try {
      response = await fetchImpl(url, {
        credentials, signal: timeout.signal,
        headers: range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}
      });
      if (!response.ok) {
        const error = new Error(response.status === 401 || response.status === 403
          ? `访问被网站拒绝（${response.status}）。请确认已登录、视频可以播放，或重新检测以更新过期链接。`
          : `下载失败：HTTP ${response.status}`);
        error.permanent = [400, 401, 403, 410].includes(response.status);
        throw error;
      }
      assertHttpUrl(response.url || url);
      if (Number(response.headers.get('content-length')) > maxBytes) {
        throw Object.assign(new Error('资源大小超过读取上限'), { permanent: true });
      }
      const chunks = [];
      let length = 0;
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          checkAbort(signal);
          length += value.byteLength;
          if (length > maxBytes) throw Object.assign(new Error('资源大小超过读取上限'), { permanent: true });
          onChunk?.(value.byteLength);
          chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      if (range) {
        if (response.status === 206) {
          const contentRange = response.headers.get('content-range');
          const match = /^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i.exec(contentRange || '');
          if (!match || Number(match[1]) !== range.offset || Number(match[2]) !== range.offset + range.length - 1 || length !== range.length) {
            throw Object.assign(new Error('服务器返回的分段字节范围不正确'), { permanent: true });
          }
        } else {
          if (length < range.offset + range.length) throw Object.assign(new Error('分段字节范围超出文件大小'), { permanent: true });
          return { bytes: bytes.slice(range.offset, range.offset + range.length), url: response.url || url };
        }
      }
      return { bytes, url: response.url || url };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      await response?.body?.cancel().catch(() => {});
      if (error.permanent || attempt === retryLimit) throw error;
      onRetry?.({ attempt: attempt + 1, error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
    await pause(500 * (attempt + 1), signal);
  }
}

export async function resolveTracks(url, { signal, quality = 'best', fetchImpl = fetch, retries = 3, onDiagnostic = () => {} } = {}) {
  const load = async (uri, depth = 0, visited = new Set()) => {
    if (depth > 5 || visited.has(uri)) throw new Error('播放列表嵌套过深或存在循环引用');
    visited.add(uri);
    const result = await requestBytes(uri, { signal, fetchImpl, retries, maxBytes: 2 * 1024 * 1024 });
    const parsed = parsePlaylist(new TextDecoder().decode(result.bytes), result.url);
    onDiagnostic('playlist-parsed', { depth, kind: parsed.kind, bytes: result.bytes.byteLength, segments: parsed.segments?.length, variants: parsed.variants?.length });
    if (parsed.kind === 'media') return { video: parsed, audio: null };
    const variant = chooseVariant(parsed.variants, quality);
    if (!variant) throw new Error('没有找到可下载的视频清晰度');
    const tracks = await load(variant.uri, depth + 1, new Set(visited));
    if (variant.audioGroup) {
      const renditions = parsed.audioRenditions.filter(item => item.groupId === variant.audioGroup);
      const audio = renditions.find(item => item.default) || renditions.find(item => item.autoselect) || renditions[0];
      if (audio?.uri) {
        const separate = await load(audio.uri, depth + 1, new Set(visited));
        tracks.audio = separate.video;
      }
    }
    return tracks;
  };
  const tracks = await load(assertHttpUrl(url));
  for (const track of [tracks.video, tracks.audio].filter(Boolean)) {
    if (!track.endList) throw new Error('检测到仍在更新的直播流。目前支持点播视频，请在直播结束后重试。');
    for (const segment of track.segments) {
      if (segment.gap) throw new Error('播放列表包含缺失分段，无法保存完整视频');
      for (const key of [segment.key, segment.map?.key].filter(Boolean)) {
        if (key.method !== 'NONE' && (key.method !== 'AES-128' || (key.keyFormat && key.keyFormat !== 'identity'))) {
          throw new Error('该视频使用 DRM 或 SAMPLE-AES 加密，当前无法下载');
        }
      }
    }
  }
  return tracks;
}

export async function decryptSegment(bytes, key, sequence, getKey, signal, isMap = false) {
  if (!key || key.method === 'NONE') return bytes;
  checkAbort(signal);
  if (key.method !== 'AES-128' || (key.keyFormat && key.keyFormat !== 'identity')) throw new Error('不支持该视频的加密方式');
  if (isMap && !key.iv) throw new Error('AES-128 加密初始化分段必须提供 IV');
  const imported = await getKey(key.uri);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: key.iv || sequenceIV(sequence) }, imported, bytes));
  } catch { throw new Error('AES-128 分段解密失败，请重新检测视频链接'); }
}

/** Streams media to disk sinks; only small HLS manifests/keys need memory. */
export async function downloadTracks(tracks, { writeFile, createSink, signal: parentSignal, concurrency = 4, retries = 3, onProgress = () => {}, fetchImpl = fetch, onDiagnostic = () => {} } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal.reason);
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  const signal = controller.signal;
  const state = { bytes: 0, completedSegments: 0, retryCount: 0, totalSegments: tracks.video.segments.length + (tracks.audio?.segments.length || 0) };
  let committedBytes = 0;
  const inFlight = new Map();
  const report = () => {
    state.bytes = committedBytes + [...inFlight.values()].reduce((sum, bytes) => sum + bytes, 0);
    onProgress({ ...state, progress: Math.round(state.completedSegments / state.totalSegments * 85) });
  };
  const retry = () => { state.retryCount++; report(); };
  const keys = new Map();
  const getKey = uri => {
    if (!keys.has(uri)) keys.set(uri, (async () => {
      const { bytes } = await requestBytes(uri, { signal, fetchImpl, retries, onRetry: retry, maxBytes: 16 });
      if (bytes.length !== 16) throw new Error('AES-128 密钥长度不正确');
      return crypto.subtle.importKey('raw', bytes, 'AES-CBC', false, ['encrypt', 'decrypt']);
    })());
    return keys.get(uri);
  };
  const fetchResource = async (resource, filename, isMap = false) => {
    checkAbort(signal);
    const createSanitizer = () => createMediaSanitizeTransform({
      expectedContainer: isMap || resource.map ? 'mp4' : 'ts',
      onInfo: info => onDiagnostic('resource-normalized', { file: filename, ...info }),
    });
    if (createSink) {
      const key = resource.key;
      // Inspect plaintext, including encrypted HLS resources. Each retry creates
      // fresh decrypt/sniff state and writes a new disk file.
      const transformFactory = async () => {
        const sanitizer = createSanitizer();
        if (!key || key.method === 'NONE') return sanitizer;
        if (key.method !== 'AES-128' || (key.keyFormat && key.keyFormat !== 'identity')) throw new Error('不支持该视频的加密方式');
        if (isMap && !key.iv) throw new Error('AES-128 加密初始化分段必须提供 IV');
        const decrypt = createAesCbcDecryptTransform(await getKey(key.uri), key.iv || sequenceIV(resource.sequence || 0));
        return { writable: decrypt.writable, readable: decrypt.readable.pipeThrough(sanitizer) };
      };
      const result = await requestToSink(resource.uri, {
        signal, fetchImpl, retries, range: resource.byteRange,
        createSink: () => createSink(filename), transformFactory,
        onRetry: ({ attempt, error }) => {
          onDiagnostic('resource-retry', { file: filename, attempt, message: error?.message });
          inFlight.set(filename, 0); retry();
        },
        onResponse: response => onDiagnostic('resource-response', {
          file: filename, httpStatus: response.status, mime: response.headers.get('content-type'),
          declaredBytes: Number(response.headers.get('content-length')) || null, ranged: Boolean(resource.byteRange), initialization: isMap,
        }),
        onProgress: ({ bytes }) => { inFlight.set(filename, bytes); report(); }
      }).catch(error => {
        onDiagnostic('resource-error', { file: filename, name: error?.name, message: error?.message });
        throw error;
      });
      onDiagnostic('resource-complete', { file: filename, bytes: result.bytes, initialization: isMap });
      inFlight.delete(filename);
      committedBytes += result.bytes;
      report();
      return;
    }
    // Retained for small in-memory callers and pure unit tests. Production uses createSink.
    const { bytes } = await requestBytes(resource.uri, {
      signal, fetchImpl, retries, onRetry: retry, range: resource.byteRange
    });
    const decrypted = await decryptSegment(bytes, resource.key, resource.sequence || 0, getKey, signal, isMap);
    const parts = [];
    let length = 0;
    const reader = new ReadableStream({ start(controller) { controller.enqueue(decrypted); controller.close(); } }).pipeThrough(createSanitizer()).getReader();
    try {
      while (true) {
        checkAbort(signal);
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value); length += value.byteLength;
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    checkAbort(signal);
    const normalized = parts.length === 1 ? parts[0] : new Uint8Array(length);
    if (parts.length > 1) {
      let offset = 0;
      for (const part of parts) { normalized.set(part, offset); offset += part.byteLength; }
    }
    await writeFile(filename, normalized);
    committedBytes += normalized.byteLength;
    report();
  };
  const tasks = [];
  const manifests = [];
  for (const [trackIndex, track] of [tracks.video, tracks.audio].filter(Boolean).entries()) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD', `#EXT-X-TARGETDURATION:${Math.max(1, Math.ceil(track.targetDuration || Math.max(...track.segments.map(item => item.duration))))}`, '#EXT-X-MEDIA-SEQUENCE:0'];
    let lastMap = '';
    const maps = new Map();
    track.segments.forEach((segment, index) => {
      if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
      if (segment.map) {
        const mapKey = JSON.stringify(segment.map);
        if (!maps.has(mapKey)) {
          const filename = `t${trackIndex}-init${maps.size}.mp4`;
          maps.set(mapKey, filename);
          tasks.push(async () => fetchResource(segment.map, filename, true));
        }
        if (lastMap !== mapKey) {
          lines.push(`#EXT-X-MAP:URI="${maps.get(mapKey)}"`);
          lastMap = mapKey;
        }
      }
      const filename = `t${trackIndex}-s${index}.${segment.map ? 'm4s' : 'ts'}`;
      lines.push(`#EXTINF:${segment.duration || 0},`, filename);
      tasks.push(async () => {
        checkAbort(signal);
        await fetchResource(segment, filename);
        state.completedSegments++;
        report();
      });
    });
    lines.push('#EXT-X-ENDLIST');
    manifests.push({ filename: `track${trackIndex}.m3u8`, text: lines.join('\n') + '\n' });
  }
  let next = 0;
  try {
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), 8, tasks.length) }, async () => {
      try { while (next < tasks.length) { checkAbort(signal); await tasks[next++](); } }
      catch (error) { controller.abort(error); throw error; }
    });
    const outcomes = await Promise.allSettled(workers);
    const failure = outcomes.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    checkAbort(signal);
    for (const manifest of manifests) await writeFile(manifest.filename, manifest.text);
    return { ...state, inputs: manifests.map(item => item.filename) };
  } finally { parentSignal?.removeEventListener('abort', abort); }
}

export function buildFFmpegArgs(inputs, { output = 'output.mp4' } = {}) {
  const args = ['-hide_banner', '-loglevel', 'info', '-nostats', '-y'];
  for (const input of inputs) args.push('-allowed_extensions', 'ALL', '-protocol_whitelist', 'file,crypto,data', '-i', input);
  args.push('-map', '0:v:0?');
  args.push('-map', inputs.length > 1 ? '1:a:0' : '0:a:0?');
  args.push('-sn', '-dn', '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', output);
  return args;
}
