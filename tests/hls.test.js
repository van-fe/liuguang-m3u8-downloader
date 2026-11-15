import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, chooseVariant, sanitizeFilename } from '../extension/lib/hls.js';

const base = 'https://media.example/path/master.m3u8?token=secret';
const media = (...lines) => ['#EXTM3U', ...lines].join('\n');

test('master playlist preserves quoted codecs/audio names and resolves all URLs', () => {
  const result = parsePlaylist(media(
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="sound",NAME="中文, 立体声",LANGUAGE="zh",DEFAULT=YES,AUTOSELECT=YES,URI="audio/list.m3u8?a=1,b=2"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="sound"',
    '../720/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080',
    '/1080.m3u8',
  ), base);
  assert.equal(result.kind, 'master');
  assert.equal(result.variants[0].uri, 'https://media.example/720/index.m3u8');
  assert.equal(result.variants[0].codecs, 'avc1.64001f,mp4a.40.2');
  assert.equal(result.variants[0].audioGroup, 'sound');
  assert.equal(result.audioRenditions[0].name, '中文, 立体声');
  assert.equal(result.audioRenditions[0].uri, 'https://media.example/path/audio/list.m3u8?a=1,b=2');
  assert.equal(result.audioRenditions[0].default, true);
  assert.equal(chooseVariant(result.variants).resolution.height, 1080);
  assert.equal(chooseVariant(result.variants, '720p').resolution.height, 720);
  assert.equal(chooseVariant(result.variants, result.variants[1].uri), result.variants[1]);
});

test('media playlist captures sequence, key rotation, NONE, gaps and discontinuities', () => {
  const result = parsePlaylist(media(
    '#EXT-X-MEDIA-SEQUENCE:128', '#EXT-X-TARGETDURATION:7',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x1',
    '#EXTINF:6.5,first', 'a.ts?x=1',
    '#EXT-X-KEY:METHOD=AES-128,URI="key2.bin"',
    '#EXT-X-DISCONTINUITY', '#EXT-X-GAP', '#EXTINF:2.25,', 'b.ts',
    '#EXT-X-KEY:METHOD=NONE', '#EXTINF:1,', 'c.ts', '#EXT-X-ENDLIST',
  ), base);
  assert.equal(result.kind, 'media');
  assert.equal(result.mediaSequence, 128);
  assert.equal(result.targetDuration, 7);
  assert.equal(result.endList, true);
  assert.equal(result.duration, 9.75);
  assert.deepEqual(result.segments.map(segment => segment.sequence), [128, 129, 130]);
  assert.equal(result.segments[0].key.uri, 'https://media.example/path/key.bin');
  assert.equal(result.segments[0].key.iv.length, 16);
  assert.equal(result.segments[0].key.iv[15], 1);
  assert.equal(result.segments[1].key.iv, null);
  assert.equal(result.segments[1].discontinuity, true);
  assert.equal(result.segments[1].gap, true);
  assert.equal(result.segments[2].key, null);
  assert.equal(result.segments[2].discontinuity, false);
});

test('fMP4 maps and explicit/implicit ranges retain initialization key state', () => {
  const result = parsePlaylist(media(
    '#EXT-X-KEY:METHOD=AES-128,URI="init.key",IV=0x2',
    '#EXT-X-MAP:URI="all.mp4",BYTERANGE="100@0"',
    '#EXT-X-KEY:METHOD=NONE', '#EXTINF:4,', '#EXT-X-BYTERANGE:200@100', 'all.mp4',
    '#EXTINF:4,', '#EXT-X-BYTERANGE:250', 'all.mp4',
    '#EXT-X-MAP:URI="all.mp4",BYTERANGE="50"',
    '#EXTINF:4,', 'last.m4s', '#EXT-X-ENDLIST',
  ), base);
  assert.deepEqual(result.segments[0].byteRange, { offset: 100, length: 200 });
  assert.deepEqual(result.segments[1].byteRange, { offset: 300, length: 250 });
  assert.equal(result.segments[0].map.key.iv[15], 2);
  assert.equal(result.segments[0].key, null);
  assert.deepEqual(result.segments[2].map.byteRange, { offset: 100, length: 50 });
  assert.equal(result.segments[2].map.key, null);
  result.segments[0].map.key.iv[15] = 9;
  assert.equal(result.segments[1].map.key.iv[15], 2);
});

test('unsupported encryption remains explicit so downloader can reject DRM', () => {
  const result = parsePlaylist(media('#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="https://keys.example/license"', '#EXTINF:4,', 'a.ts'), base);
  assert.equal(result.segments[0].key.method, 'SAMPLE-AES');
  assert.equal(result.segments[0].key.keyFormat, 'com.apple.streamingkeydelivery');
  assert.equal(result.endList, false);
});

test('playlist snapshots do not invent URLs, inherit manifest tokens or require ENDLIST', () => {
  const result = parsePlaylist('\uFEFF#EXTM3U\r\n#EXTINF:3,\r\n./a.ts\r\n', base);
  assert.equal(result.segments[0].uri, 'https://media.example/path/a.ts');
  assert.equal(result.endList, false);
  assert.equal(result.duration, 3);
});

test('malformed and incomplete playlists fail with actionable errors', () => {
  for (const [playlist, message] of [
    ['<html>no access</html>', /有效的 M3U8/],
    [media('#EXT-X-ENDLIST'), /没有可下载/],
    [media('#EXTINF:4,', '#EXT-X-BYTERANGE:10', 'a.ts'), /隐式字节范围/],
    [media('#EXTINF:4,', '#EXT-X-BYTERANGE:10@0', 'a.ts', '#EXTINF:4,', '#EXT-X-BYTERANGE:10', 'b.ts'), /隐式字节范围/],
    [media('#EXT-X-KEY:METHOD=AES-128,URI="key",IV=0xINVALID', '#EXTINF:4,', 'a.ts'), /IV/],
    [media('#EXT-X-KEY:METHOD=AES-128', '#EXTINF:4,', 'a.ts'), /密钥地址/],
    [media('#EXTINF:-1,', 'a.ts'), /分片时长/],
    [media('#EXTINF:4,'), /缺少资源地址/],
    [media('#EXTINF:4,', 'javascript:alert(1)'), /HTTP/],
    [media('#EXT-X-STREAM-INF:BANDWIDTH=100'), /缺少资源地址/],
    [media('#EXT-X-MEDIA-SEQUENCE:9007199254740992', '#EXTINF:4,', 'a.ts'), /超出允许范围/],
    [media('#EXT-X-SKIP:SKIPPED-SEGMENTS=5', '#EXTINF:4,', 'a.ts'), /增量/],
  ]) assert.throws(() => parsePlaylist(playlist, base), message);
});

test('variant choice prefers resolution over bitrate and leaves caller array unchanged', () => {
  const variants = [
    { uri: '720', resolution: { width: 1280, height: 720 }, bandwidth: 9000000 },
    { uri: '1080low', resolution: { width: 1920, height: 1080 }, bandwidth: 2000000 },
    { uri: '1080high', resolution: { width: 1920, height: 1080 }, bandwidth: 3000000 },
  ];
  assert.equal(chooseVariant(variants).uri, '1080high');
  assert.equal(chooseVariant(variants, 480).uri, '720');
  assert.equal(variants[0].uri, '720');
  assert.throws(() => chooseVariant([]), /没有可用/);
});

test('filenames remove traversal/control characters, preserve Chinese, avoid reserved devices', () => {
  assert.equal(sanitizeFilename('电影: 第 1 集.mp4'), '电影_ 第 1 集.mp4');
  assert.equal(sanitizeFilename('../CON.mp4'), '.._CON.mp4');
  assert.equal(sanitizeFilename('CON.mp4'), '_CON.mp4');
  assert.equal(sanitizeFilename(' aux.txt '), '_aux.txt.mp4');
  assert.equal(sanitizeFilename('...'), 'video.mp4');
  assert.equal(sanitizeFilename('a\u0000b/\\:*?"<>|. '), 'a_b_________.mp4');
  assert.equal(sanitizeFilename('😀'.repeat(150)).length, 244);
});
