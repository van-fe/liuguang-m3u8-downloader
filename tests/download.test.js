import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { parsePlaylist } from '../extension/lib/hls.js';
import {
  assertHttpUrl, sequenceIV, requestBytes, resolveTracks,
  decryptSegment, downloadTracks, buildFFmpegArgs,
} from '../extension/lib/download.js';

const origin = 'https://video.example/';
const playlist = (...lines) => ['#EXTM3U', ...lines].join('\n');
const vod = (...segments) => playlist(...segments.flatMap(uri => ['#EXTINF:4,', uri]), '#EXT-X-ENDLIST');

function response(body, { url, status = 200, headers = {} } = {}) {
  const result = new Response(body, { status, headers });
  if (url) Object.defineProperty(result, 'url', { value: url });
  return result;
}

function mockFetch(resources) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.ok(Object.hasOwn(resources, url), `Unexpected network request: ${url}`);
    const resource = resources[url];
    return typeof resource === 'function' ? resource(options) : response(resource, { url });
  };
  return { fetchImpl, calls };
}

async function encrypt(plaintext, rawKey, iv) {
  const key = await webcrypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt']);
  return new Uint8Array(await webcrypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext));
}

function diskStore() {
  const files = new Map();
  const attempts = new Map();
  return {
    files, attempts,
    async createSink(name) {
      const entry = { parts: [], closed: false, aborted: false };
      if (!attempts.has(name)) attempts.set(name, []);
      attempts.get(name).push(entry);
      return {
        async write(bytes) { entry.parts.push(bytes.slice()); },
        async close() { entry.closed = true; files.set(name, new Uint8Array(Buffer.concat(entry.parts))); },
        async abort() { entry.aborted = true; },
      };
    },
    async writeFile(name, text) {
      assert.equal(typeof text, 'string', 'media must use disk sinks rather than the buffered writeFile fallback');
      files.set(name, text);
    },
  };
}

test('URL validation rejects credentials and non-HTTP schemes', () => {
  assert.equal(assertHttpUrl('https://video.example/a.m3u8'), 'https://video.example/a.m3u8');
  for (const url of ['file:///video.m3u8', 'javascript:alert(1)', 'https://user:pass@video.example/a']) {
    assert.throws(() => assertHttpUrl(url), /HTTP/);
  }
});

test('redirected manifests resolve relative variants, segments and default external audio', async () => {
  const { fetchImpl, calls } = mockFetch({
    'https://video.example/entry': () => response(playlist(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",URI="en.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="中文",DEFAULT=YES,URI="zh.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=100,RESOLUTION=1280x720,AUDIO="a"', '720/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=200,RESOLUTION=1920x1080,AUDIO="a"', '1080/index.m3u8',
    ), { url: 'https://cdn.example/hls/master.m3u8?token=old' }),
    'https://cdn.example/hls/720/index.m3u8': () => response(vod('seg.ts'), { url: 'https://edge.example/new/list.m3u8' }),
    'https://cdn.example/hls/zh.m3u8': vod('zh.aac'),
  });
  const tracks = await resolveTracks('https://video.example/entry', { quality: '720p', fetchImpl });
  assert.equal(tracks.video.segments[0].uri, 'https://edge.example/new/seg.ts');
  assert.equal(tracks.audio.segments[0].uri, 'https://cdn.example/hls/zh.aac');
  assert.deepEqual(calls.map(call => call.url), [
    'https://video.example/entry', 'https://cdn.example/hls/720/index.m3u8', 'https://cdn.example/hls/zh.m3u8',
  ]);
  assert.ok(calls.every(call => call.options.credentials === 'include'));
});

test('audio selection prefers AUTOSELECT when the group has no default', async () => {
  const { fetchImpl } = mockFetch({
    [`${origin}master.m3u8`]: playlist(
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="other",NAME="Other",DEFAULT=YES,URI="other.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="selected",NAME="First",URI="first.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="selected",NAME="Auto",AUTOSELECT=YES,URI="auto.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=100,AUDIO="selected"', 'video.m3u8',
    ),
    [`${origin}video.m3u8`]: vod('video.ts'),
    [`${origin}auto.m3u8`]: vod('auto.aac'),
  });
  const tracks = await resolveTracks(`${origin}master.m3u8`, { fetchImpl });
  assert.equal(tracks.audio.segments[0].uri, `${origin}auto.aac`);
});

test('resolveTracks refuses live snapshots, missing segments, DRM and DRM initialization maps', async () => {
  for (const [source, expected] of [
    [playlist('#EXTINF:4,', 'a.ts'), /直播/],
    [playlist('#EXT-X-GAP', '#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST'), /缺失分段/],
    [playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="license"', '#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST'), /DRM/],
    [playlist('#EXT-X-KEY:METHOD=AES-128,KEYFORMAT="com.widevine",URI="license"', '#EXTINF:4,', 'a.ts', '#EXT-X-ENDLIST'), /DRM/],
    [playlist('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="license"', '#EXT-X-MAP:URI="init.mp4"', '#EXT-X-KEY:METHOD=NONE', '#EXTINF:4,', 'a.m4s', '#EXT-X-ENDLIST'), /DRM/],
  ]) {
    const { fetchImpl } = mockFetch({ [`${origin}index.m3u8`]: source });
    await assert.rejects(resolveTracks(`${origin}index.m3u8`, { fetchImpl }), expected);
  }
});

test('resolveTracks refuses circular master playlists before repeating requests', async () => {
  const { fetchImpl, calls } = mockFetch({
    [`${origin}a.m3u8`]: playlist('#EXT-X-STREAM-INF:BANDWIDTH=100', 'b.m3u8'),
    [`${origin}b.m3u8`]: playlist('#EXT-X-STREAM-INF:BANDWIDTH=100', 'a.m3u8'),
  });
  await assert.rejects(resolveTracks(`${origin}a.m3u8`, { fetchImpl }), /循环/);
  assert.equal(calls.length, 2);
});

test('range requests validate 206 responses and slice a server-provided complete file', async () => {
  const range = { offset: 2, length: 3 };
  let captured;
  const partial = await requestBytes(`${origin}video.mp4`, {
    range,
    fetchImpl: async (url, options) => {
      captured = options;
      return response(Uint8Array.of(2, 3, 4), { url, status: 206, headers: { 'Content-Range': 'bytes 2-4/8' } });
    },
  });
  assert.equal(captured.headers.Range, 'bytes=2-4');
  assert.deepEqual([...partial.bytes], [2, 3, 4]);
  const full = await requestBytes(`${origin}video.mp4`, {
    range, fetchImpl: async url => response(Uint8Array.of(0, 1, 2, 3, 4, 5), { url }),
  });
  assert.deepEqual([...full.bytes], [2, 3, 4]);
});

test('range requests reject mismatched offsets, lengths, absent Content-Range and short full files', async () => {
  for (const options of [
    { status: 206, body: Uint8Array.of(2, 3, 4), headers: { 'Content-Range': 'bytes 1-3/8' } },
    { status: 206, body: Uint8Array.of(2, 3), headers: { 'Content-Range': 'bytes 2-4/8' } },
    { status: 206, body: Uint8Array.of(2, 3, 4), headers: {} },
    { status: 200, body: Uint8Array.of(0, 1), headers: {} },
  ]) {
    let attempts = 0;
    await assert.rejects(requestBytes(`${origin}video.mp4`, {
      range: { offset: 2, length: 3 },
      fetchImpl: async url => { attempts++; return response(options.body, { ...options, url }); },
    }), /字节范围/);
    assert.equal(attempts, 1, 'invalid ranges must fail permanently');
  }
});

test('requestBytes enforces both declared and streamed memory limits', async () => {
  for (const headers of [{ 'Content-Length': '7' }, {}]) {
    let attempts = 0;
    await assert.rejects(requestBytes(`${origin}video.ts`, {
      maxBytes: 4,
      fetchImpl: async url => { attempts++; return response(Uint8Array.of(0, 1, 2, 3, 4, 5, 6), { url, headers }); },
    }), /读取上限/);
    assert.equal(attempts, 1);
  }
});

test('permission errors fail without retries and explain expired/login URLs', async () => {
  let calls = 0;
  await assert.rejects(requestBytes(`${origin}blocked.m3u8`, {
    fetchImpl: async url => { calls++; return response('denied', { url, status: 403 }); },
  }), /403.*登录/);
  assert.equal(calls, 1);
});

test('requestBytes retries transient failures and reports each retry attempt', async () => {
  let calls = 0;
  const retryAttempts = [];
  const result = await requestBytes(`${origin}transient.ts`, {
    retries: 3,
    onRetry: ({ attempt, error }) => { retryAttempts.push(attempt); assert.match(error.message, /503/); },
    fetchImpl: async url => response(++calls === 1 ? 'temporarily unavailable' : Uint8Array.of(8, 9), {
      url, status: calls === 1 ? 503 : 200,
    }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(retryAttempts, [1]);
  assert.deepEqual([...result.bytes], [8, 9]);
});

test('requestBytes respects zero retries and the configured three-retry limit', async () => {
  for (const retries of [0, 3]) {
    let calls = 0;
    const retryAttempts = [];
    await assert.rejects(requestBytes(`${origin}unavailable.ts`, {
      retries,
      onRetry: ({ attempt }) => retryAttempts.push(attempt),
      fetchImpl: async url => { calls++; return response('temporarily unavailable', { url, status: 503 }); },
    }), /503/);
    assert.equal(calls, retries + 1);
    assert.deepEqual(retryAttempts, retries === 0 ? [] : [1, 2, 3]);
  }
});

test('AES-128 decryption uses full 128-bit big-endian sequence IVs and explicit IVs', async () => {
  assert.deepEqual([...sequenceIV(0x100000001)], [...new Uint8Array(11), 1, 0, 0, 0, 1]);
  const raw = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const imported = await webcrypto.subtle.importKey('raw', raw, 'AES-CBC', false, ['decrypt']);
  const plaintext = new TextEncoder().encode('真实视频分片测试：非整数个 AES block');
  for (const explicitIv of [null, Uint8Array.from({ length: 16 }, (_, i) => 32 - i)]) {
    const cipher = await encrypt(plaintext, raw, explicitIv || sequenceIV(257));
    let keyUri;
    const decrypted = await decryptSegment(cipher, { method: 'AES-128', uri: `${origin}key`, iv: explicitIv }, 257, async uri => {
      keyUri = uri;
      return imported;
    });
    assert.deepEqual(decrypted, plaintext);
    assert.equal(keyUri, `${origin}key`);
  }
  assert.equal(await decryptSegment(plaintext, null, 0, null), plaintext);
  await assert.rejects(decryptSegment(plaintext, { method: 'AES-128' }, 0, () => imported, undefined, true), /初始化分段必须提供 IV/);
  await assert.rejects(decryptSegment(Uint8Array.of(1, 2), { method: 'AES-128', uri: 'key' }, 0, () => imported), /解密失败/);
  await assert.rejects(decryptSegment(plaintext, { method: 'SAMPLE-AES' }, 0, null), /不支持/);
});

test('downloadTracks preserves manifest order, discontinuities, audio and encrypted map state while caching maps/keys', async () => {
  const rawKey = Uint8Array.from({ length: 16 }, (_, i) => i);
  const map1Plain = new TextEncoder().encode('first initialization');
  const map2Plain = new TextEncoder().encode('second initialization');
  const map1Cipher = await encrypt(map1Plain, rawKey, sequenceIV(1));
  const map2Cipher = await encrypt(map2Plain, rawKey, sequenceIV(2));
  const video = parsePlaylist(playlist(
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1', '#EXT-X-MAP:URI="init1.mp4"', '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:4,', 'v0.m4s', '#EXTINF:4,', 'v1.m4s',
    '#EXT-X-DISCONTINUITY', '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x2', '#EXT-X-MAP:URI="init2.mp4"', '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:4,', 'v2.m4s',
    '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1', '#EXT-X-MAP:URI="init1.mp4"', '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:4,', 'v3.m4s', '#EXT-X-ENDLIST',
  ), `${origin}video.m3u8`);
  const audio = parsePlaylist(vod('audio.aac'), `${origin}audio.m3u8`);
  const { fetchImpl, calls } = mockFetch({
    [`${origin}key`]: rawKey,
    [`${origin}init1.mp4`]: map1Cipher,
    [`${origin}init2.mp4`]: map2Cipher,
    [`${origin}v0.m4s`]: async () => { await new Promise(resolve => setTimeout(resolve, 20)); return response(Uint8Array.of(0)); },
    [`${origin}v1.m4s`]: Uint8Array.of(1),
    [`${origin}v2.m4s`]: Uint8Array.of(2),
    [`${origin}v3.m4s`]: Uint8Array.of(3),
    [`${origin}audio.aac`]: Uint8Array.of(7, 8),
  });
  const files = new Map();
  const writes = [];
  const progress = [];
  const result = await downloadTracks({ video, audio }, {
    fetchImpl, concurrency: 4,
    writeFile: async (name, bytes) => { writes.push(name); files.set(name, bytes); },
    onProgress: item => progress.push(item),
  });
  assert.deepEqual(result.inputs, ['track0.m3u8', 'track1.m3u8']);
  assert.equal(result.completedSegments, 5);
  assert.equal(result.totalSegments, 5);
  assert.equal(result.bytes, map1Plain.length + map2Plain.length + 6);
  assert.equal(progress.at(-1).progress, 85);
  assert.deepEqual([...new Set(progress.map(item => item.completedSegments).filter(Boolean))], [1, 2, 3, 4, 5]);
  assert.ok(writes.indexOf('t0-s1.m4s') < writes.indexOf('t0-s0.m4s'), 'fixture must finish out of order');
  assert.equal(calls.filter(call => call.url === `${origin}key`).length, 1);
  assert.equal(calls.filter(call => call.url === `${origin}init1.mp4`).length, 1);
  assert.deepEqual(files.get('t0-init0.mp4'), map1Plain);
  assert.deepEqual(files.get('t0-init1.mp4'), map2Plain);
  const local = files.get('track0.m3u8');
  assert.deepEqual(local.match(/t0-s\d+\.m4s/g), ['t0-s0.m4s', 't0-s1.m4s', 't0-s2.m4s', 't0-s3.m4s']);
  assert.deepEqual(local.match(/#EXT-X-MAP:URI="[^"]+"/g), [
    '#EXT-X-MAP:URI="t0-init0.mp4"', '#EXT-X-MAP:URI="t0-init1.mp4"', '#EXT-X-MAP:URI="t0-init0.mp4"',
  ]);
  assert.match(local, /#EXT-X-DISCONTINUITY\n#EXT-X-MAP:URI="t0-init1.mp4"\n#EXTINF:4,\nt0-s2.m4s/);
  assert.match(local, /#EXT-X-ENDLIST\n$/);
  assert.doesNotMatch(local, /https?:|#EXT-X-KEY|#EXT-X-BYTERANGE/);
  assert.match(files.get('track1.m3u8'), /t1-s0.ts/);
  assert.ok(writes.indexOf('track0.m3u8') > writes.indexOf('t0-s0.m4s'));
});

test('HTTP 200 range fallback counts retained slices rather than repeated complete responses', async () => {
  const video = parsePlaylist(playlist(
    '#EXT-X-MAP:URI="all.mp4",BYTERANGE="2@0"',
    '#EXTINF:4,', '#EXT-X-BYTERANGE:3@2', 'all.mp4',
    '#EXTINF:4,', '#EXT-X-BYTERANGE:3', 'all.mp4', '#EXT-X-ENDLIST',
  ), `${origin}range.m3u8`);
  const fullResource = Uint8Array.from({ length: 100 }, (_, index) => index);
  const ranges = [];
  const files = new Map();
  const result = await downloadTracks({ video, audio: null }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, `${origin}all.mp4`);
      ranges.push(options.headers.Range);
      return response(fullResource, { url, status: 200 });
    },
    writeFile: async (name, bytes) => files.set(name, bytes),
  });
  assert.deepEqual(ranges.sort(), ['bytes=0-1', 'bytes=2-4', 'bytes=5-7']);
  assert.equal(result.bytes, 8, '300 fetched bytes retain only 8 input bytes');
  assert.equal(result.completedSegments, 2);
  assert.deepEqual([...files.get('t0-init0.mp4')], [0, 1]);
  assert.deepEqual([...files.get('t0-s0.m4s')], [2, 3, 4]);
  assert.deepEqual([...files.get('t0-s1.m4s')], [5, 6, 7]);
});

test('disk sink integration decrypts map keys and sequence-IV segments before writing local manifests', async () => {
  const rawKey = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
  const init = new TextEncoder().encode('encrypted initialization with explicit map IV');
  const encryptedPlain = new Uint8Array(1024 * 1024 + 3).fill(37);
  const unencrypted = Uint8Array.of(8, 9, 10);
  const initCipher = await encrypt(init, rawKey, sequenceIV(1));
  const segmentCipher = await encrypt(encryptedPlain, rawKey, sequenceIV(32));
  const video = parsePlaylist(playlist(
    '#EXT-X-MEDIA-SEQUENCE:32',
    '#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0x1', '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-KEY:METHOD=AES-128,URI="key"', '#EXTINF:4,', 'encrypted.m4s',
    '#EXT-X-KEY:METHOD=NONE', '#EXTINF:4,', 'plain.m4s', '#EXT-X-ENDLIST',
  ), `${origin}video.m3u8`);
  const { fetchImpl, calls } = mockFetch({
    [`${origin}key`]: rawKey,
    [`${origin}init.mp4`]: initCipher,
    [`${origin}encrypted.m4s`]: segmentCipher,
    [`${origin}plain.m4s`]: unencrypted,
  });
  const disk = diskStore();
  const progress = [];
  const result = await downloadTracks({ video, audio: null }, {
    ...disk, fetchImpl, concurrency: 3, onProgress: state => progress.push(state),
  });
  assert.deepEqual(disk.files.get('t0-init0.mp4'), init);
  assert.deepEqual(disk.files.get('t0-s0.m4s'), encryptedPlain);
  assert.deepEqual(disk.files.get('t0-s1.m4s'), unencrypted);
  assert.equal(calls.filter(call => call.url === `${origin}key`).length, 1);
  assert.equal(result.bytes, init.length + encryptedPlain.length + unencrypted.length);
  assert.equal(result.completedSegments, 2);
  assert.equal(progress.at(-1).bytes, result.bytes);
  assert.deepEqual([...new Set(progress.map(state => state.completedSegments).filter(Boolean))], [1, 2]);
  assert.match(disk.files.get('track0.m3u8'), /#EXT-X-MAP:URI="t0-init0.mp4"/);
  assert.doesNotMatch(disk.files.get('track0.m3u8'), /#EXT-X-KEY|https?:/);
  assert.ok([...disk.attempts.values()].flat().every(attempt => attempt.closed && !attempt.aborted));
});

test('disk sink integration retries one failed segment into a fresh file without double-counting partial bytes', async () => {
  const video = parsePlaylist(vod('retry.ts', 'ok.ts'), `${origin}video.m3u8`);
  const disk = diskStore();
  let retryRequests = 0;
  const progress = [];
  const result = await downloadTracks({ video, audio: null }, {
    ...disk, concurrency: 2, retries: 1, onProgress: state => progress.push(state),
    fetchImpl: async requestUrl => {
      if (requestUrl.endsWith('/ok.ts')) return response(Uint8Array.of(4, 5, 6, 7));
      assert.equal(requestUrl, `${origin}retry.ts`);
      if (++retryRequests > 1) return response(Uint8Array.of(1, 2, 3));
      let reads = 0;
      return response(new ReadableStream({
        pull(controller) {
          if (reads++ === 0) controller.enqueue(Uint8Array.of(99, 99));
          else controller.error(new TypeError('connection reset'));
        },
      }, { highWaterMark: 0 }));
    },
  });
  assert.equal(retryRequests, 2);
  assert.equal(result.retryCount, 1);
  assert.equal(result.bytes, 7);
  assert.equal(progress.at(-1).bytes, 7);
  assert.deepEqual([...disk.files.get('t0-s0.ts')], [1, 2, 3]);
  assert.deepEqual([...disk.files.get('t0-s1.ts')], [4, 5, 6, 7]);
  const attempts = disk.attempts.get('t0-s0.ts');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].aborted, true);
  assert.equal(attempts[1].closed, true);
});

test('a permanent segment failure aborts sibling network/sinks and waits for cleanup before rejecting', async () => {
  const video = parsePlaylist(vod('denied.ts', 'stalled.ts', 'unstarted.ts'), `${origin}video.m3u8`);
  const disk = diskStore();
  const requests = [];
  let siblingCancelled = false;
  await assert.rejects(downloadTracks({ video, audio: null }, {
    ...disk, concurrency: 2,
    fetchImpl: async requestUrl => {
      requests.push(requestUrl);
      if (requestUrl.endsWith('/denied.ts')) return response('denied', { status: 403 });
      assert.equal(requestUrl, `${origin}stalled.ts`);
      return response(new ReadableStream({ pull() {}, cancel() { siblingCancelled = true; } }));
    },
  }), /403/);
  assert.equal(siblingCancelled, true);
  assert.equal(requests.length, 2);
  assert.equal(disk.files.size, 0, 'no manifest should be committed after a media failure');
  assert.ok([...disk.attempts.values()].flat().every(attempt => attempt.aborted && !attempt.closed));
});

test('disk sink integration aggregates more than 4 GiB with bounded reusable stream chunks', async () => {
  const video = parsePlaylist(vod('large0.ts', 'large1.ts'), `${origin}video.m3u8`);
  const chunk = new Uint8Array(1024 * 1024);
  const chunksPerResource = 2300;
  const retained = new Map();
  let largestWrite = 0;
  const manifests = new Map();
  const result = await downloadTracks({ video, audio: null }, {
    concurrency: 2,
    createSink: async name => ({
      async write(bytes) {
        retained.set(name, (retained.get(name) || 0) + bytes.length);
        largestWrite = Math.max(largestWrite, bytes.length);
      },
      close: async () => {}, abort: async () => {},
    }),
    writeFile: async (name, text) => { assert.equal(typeof text, 'string'); manifests.set(name, text); },
    fetchImpl: async () => {
      let produced = 0;
      return response(new ReadableStream({
        pull(controller) {
          if (produced++ < chunksPerResource) controller.enqueue(chunk);
          else controller.close();
        },
      }));
    },
  });
  assert.equal(result.bytes, 2 * chunksPerResource * chunk.length);
  assert.ok(result.bytes > 2 ** 32);
  assert.equal(retained.get('t0-s0.ts'), chunksPerResource * chunk.length);
  assert.equal(retained.get('t0-s1.ts'), chunksPerResource * chunk.length);
  assert.equal(largestWrite, chunk.length);
  assert.equal(result.completedSegments, 2);
  assert.ok(manifests.has('track0.m3u8'));
});

test('downloadTracks bounds concurrent fetches and propagates external cancellation', async () => {
  const video = parsePlaylist(vod('0.ts', '1.ts', '2.ts', '3.ts'), `${origin}video.m3u8`);
  let running = 0;
  let peak = 0;
  await downloadTracks({ video, audio: null }, {
    concurrency: 2, writeFile: async () => {},
    fetchImpl: async () => {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 5));
      running--;
      return response(Uint8Array.of(0));
    },
  });
  assert.equal(peak, 2);
  const controller = new AbortController();
  const cancelled = new DOMException('用户取消', 'AbortError');
  let cancelledRequests = 0;
  let writes = 0;
  const pending = downloadTracks({ video, audio: null }, {
    concurrency: 2, signal: controller.signal, writeFile: async () => { writes++; },
    fetchImpl: async (url, { signal }) => {
      cancelledRequests++;
      return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  });
  setTimeout(() => controller.abort(cancelled), 5);
  await assert.rejects(pending, error => error === cancelled);
  assert.equal(cancelledRequests, 2);
  assert.equal(writes, 0);
});

test('FFmpeg arguments map separate audio explicitly and remux MP4 with faststart', () => {
  const combined = buildFFmpegArgs(['track0.m3u8']);
  assert.ok(combined.includes('0:v:0?'));
  assert.ok(combined.includes('0:a:0?'));
  const separate = buildFFmpegArgs(['track0.m3u8', 'track1.m3u8']);
  assert.ok(separate.includes('1:a:0'));
  assert.ok(!separate.includes('0:a:0?'));
  assert.equal(separate.filter(arg => arg === '-i').length, 2);
  assert.deepEqual(separate.slice(-7), ['-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', 'output.mp4']);
  assert.ok(separate.includes('file,crypto,data'));
});
