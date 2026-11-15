import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSanitizeTransform } from '../extension/lib/media-sanitize.js';

const LIMIT = 64 * 1024;
const PACKETS = 188 * 5;
const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'));
// The first five complete packets from FFmpeg's generated 32x32 H.264 blue
// frame transport stream: SDT, real CRC-protected PAT/PMT, PES, and video data.
// Runtime tests need neither native FFmpeg nor any network fixture.
const TS = new Uint8Array(Buffer.from('R0AREABC8CUAAcEAAP8B/wAB/IAUSBIBBkZGbXBlZwlTZXJ2aWNlMDF3fEPK//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////9HQAAQAACwDQABwQAAAAHwACqxBLL//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////0dQABAAArASAAHBAADhAPAAG+EA8AAVvU1W////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////R0EAMAdQAAB7DH4AAAAB4AAAgIAFIQAH2GEAAAABCfAAAAABZ0LACtolsBEAAAMAAQAAAwACjxImoAAAAAFozg/IAAABBgX//0HcRem95tlIt5Ys2CDZI+7veDI2NCAtIGNvcmUgMTY1IC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCBHAQARLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0xIGRlYmxvY2s9MDowOjAgYW5hbHlzZT0wOjAgbWU9ZGlhIHN1Ym1lPTAgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MCBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTAgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYQ==', 'base64'));

function join(...parts) { return new Uint8Array(Buffer.concat(parts)); }

function chunks(bytes, sizes = [1, 7, 187, 188, 189, 1023]) {
  let offset = 0;
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.byteLength) { controller.close(); return; }
      const end = Math.min(bytes.byteLength, offset + sizes[index++ % sizes.length]);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    }
  }, { highWaterMark: 0 });
}

async function sanitized(bytes, { sizes, ...options } = {}) {
  const reader = chunks(bytes, sizes).pipeThrough(createMediaSanitizeTransform(options)).getReader();
  const parts = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    assert.ok(value instanceof Uint8Array);
    assert.ok(value.byteLength <= 1024 * 1024);
    parts.push(value);
  }
  return join(...parts);
}

function prefix(length = 70, magic = PNG) {
  const bytes = new Uint8Array(length);
  bytes.set(magic.subarray(0, Math.min(magic.length, length)));
  return bytes;
}

function randomSizes(seed) {
  return Array.from({ length: 31 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return (seed % 1301) + 1;
  });
}

test('70-byte PNG prefix is removed from real structural TS across random chunk boundaries', async () => {
  assert.equal(PNG.length, 70);
  assert.equal(TS.length, PACKETS);
  for (let seed = 1; seed <= 24; seed++) {
    const infos = [];
    assert.deepEqual(await sanitized(join(PNG, TS), { sizes: randomSizes(seed), expectedContainer: 'ts', onInfo: info => infos.push(info) }), TS);
    assert.deepEqual(infos, [{ container: 'mpegts', removedPrefixBytes: 70, reason: 'image-prefix' }]);
  }
});

test('normal TS, MP4 init/media fragments and ID3/AAC remain byte-identical', async () => {
  const samples = [
    TS,
    join(Uint8Array.of(0, 0, 0, 24), new TextEncoder().encode('ftypisom'), new Uint8Array(100)),
    join(Uint8Array.of(0, 0, 0, 32), new TextEncoder().encode('moof'), new Uint8Array(100)),
    join(new TextEncoder().encode('ID3'), Uint8Array.of(4, 0, 0, 0, 0, 0, 0, 0xff, 0xf1, 0x50, 0x80), new Uint8Array(2048)),
    Uint8Array.of(0xff, 0xf1, 0x50, 0x80, 1, 2, 3)
  ];
  for (const bytes of samples) for (const expectedContainer of [null, 'ts', 'mp4']) {
    const infos = [];
    assert.deepEqual(await sanitized(bytes, { expectedContainer, sizes: [1], onInfo: info => infos.push(info) }), bytes);
    assert.equal(infos.length, 0);
  }
  assert.deepEqual(await sanitized(new Uint8Array()), new Uint8Array());
});

test('recognizable PNG, JPEG, GIF87a/GIF89a and WebP may wrap TS without hard-coding prefix length', async () => {
  const magics = [PNG, Uint8Array.of(0xff, 0xd8, 0xff, 0xe0), new TextEncoder().encode('GIF87a'), new TextEncoder().encode('GIF89a'), new TextEncoder().encode('RIFF1234WEBP')];
  for (const magic of magics) for (const size of [31, 70, 446, 3009]) {
    const infos = [];
    assert.deepEqual(await sanitized(join(prefix(size, magic), TS), { onInfo: info => infos.push(info) }), TS);
    assert.equal(infos[0].removedPrefixBytes, size);
    assert.deepEqual(Object.keys(infos[0]).sort(), ['container', 'reason', 'removedPrefixBytes']);
  }
});

test('unknown prefixes and ordinary non-image RIFF data are never stripped', async () => {
  const inputs = [join(new TextEncoder().encode('ordinary-data'), TS), join(new TextEncoder().encode('RIFF1234WAVE'), TS)];
  for (const bytes of inputs) assert.deepEqual(await sanitized(bytes), bytes);
});

test('real images, partial packet runs and malformed TS do not become false video', async () => {
  const fake = new Uint8Array(PACKETS);
  for (let packet = 0; packet < 5; packet++) {
    const offset = packet * 188;
    fake.set([0x47, 0x01, 0x00, 0x10], offset); // legal-looking headers, repeated CC, no PES/PSI
  }
  const badControl = TS.slice(); badControl[3] &= 0xcf;
  const transportError = TS.slice(); transportError[1] |= 0x80;
  const scrambled = TS.slice(); scrambled[3] |= 0xc0;
  const badAdaptation = TS.slice(); badAdaptation.set([0x47, 1, 0, 0x30, 183], 0);
  for (const bytes of [PNG, join(PNG, TS.subarray(0, 188 * 4)), join(PNG, TS.subarray(0, PACKETS - 1)),
    join(PNG, fake), join(PNG, badControl), join(PNG, transportError), join(PNG, scrambled), join(PNG, badAdaptation)]) {
    const infos = [];
    await assert.rejects(sanitized(bytes, { onInfo: info => infos.push(info) }), error => error.code === 'IMAGE_SEGMENT_NO_VIDEO' && /分片返回图片，未找到有效视频数据/.test(error.message));
    assert.equal(infos.length, 0);
  }
});

test('an MP4 hint keeps real MP4 untouched and conservatively rejects image-wrapped TS', async () => {
  await assert.rejects(sanitized(join(PNG, TS), { expectedContainer: 'mp4' }), /分片返回图片/);
});

test('prefix at the 64 KiB boundary is supported while later prefixes are rejected', async () => {
  const infos = [];
  assert.deepEqual(await sanitized(join(prefix(LIMIT), TS), { sizes: [8191, 1, 4096, 187], onInfo: info => infos.push(info) }), TS);
  assert.equal(infos[0].removedPrefixBytes, LIMIT);
  await assert.rejects(sanitized(join(prefix(LIMIT + 1), TS), { sizes: [98304] }), /分片返回图片/);
});

test('large image response stops inspecting at bounded prefix+probe bytes and emits no image data', async () => {
  let inspected = 0;
  let output = 0;
  class TrackedChunk extends Uint8Array {
    subarray(start, end) {
      assert.ok(end <= LIMIT + PACKETS, `read beyond bounded sniff window: ${end}`);
      inspected = Math.max(inspected, end);
      return super.subarray(start, end);
    }
  }
  const bytes = new TrackedChunk(8 * 1024 * 1024);
  bytes.set(PNG);
  const reader = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } })
    .pipeThrough(createMediaSanitizeTransform()).getReader();
  await assert.rejects((async () => {
    while (true) { const result = await reader.read(); if (result.done) return; output += result.value.length; }
  })(), /分片返回图片/);
  assert.equal(output, 0);
  assert.equal(inspected, LIMIT + PACKETS);
});

test('sanitizer emits before source completion and bounds outputs for multi-MiB chunks', async () => {
  const first = join(PNG, TS);
  const bulk = new Uint8Array(3 * 1024 * 1024 + 17);
  let sent = 0;
  let ended = false;
  const source = new ReadableStream({ pull(controller) {
    if (sent++ === 0) controller.enqueue(first);
    else if (sent <= 4) controller.enqueue(bulk);
    else { ended = true; controller.close(); }
  } }, { highWaterMark: 0 });
  const reader = source.pipeThrough(createMediaSanitizeTransform()).getReader();
  let total = 0;
  let reads = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (reads++ === 0) { assert.deepEqual(value, TS); assert.equal(ended, false); }
    assert.ok(value.length <= 1024 * 1024);
    total += value.length;
  }
  assert.equal(total, TS.length + 3 * bulk.length);
  assert.ok(reads > 4);
});

test('cancellation propagates and a fresh retry has independent sniff state', async () => {
  let cancelled = false;
  const source = new ReadableStream({ start(controller) { controller.enqueue(PNG); }, cancel() { cancelled = true; } });
  const reader = source.pipeThrough(createMediaSanitizeTransform()).getReader();
  const pending = reader.read();
  await new Promise(resolve => setImmediate(resolve));
  await reader.cancel('cancelled');
  assert.equal((await pending).done, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.deepEqual(await sanitized(join(PNG, TS)), TS);
});

test('invalid options and invalid chunk types reject clearly', async () => {
  assert.throws(() => createMediaSanitizeTransform({ expectedContainer: 'unknown' }), TypeError);
  assert.throws(() => createMediaSanitizeTransform({ onInfo: null }), TypeError);
  const reader = new ReadableStream({ start(controller) { controller.enqueue('not bytes'); controller.close(); } })
    .pipeThrough(createMediaSanitizeTransform()).getReader();
  await assert.rejects(reader.read(), /Uint8Array/);
});
