const SNIFF_BYTES = 64 * 1024;
const OUTPUT_BYTES = 1024 * 1024;
const PACKET_BYTES = 188;
const PACKET_COUNT = 5;
const PROBE_BYTES = PACKET_BYTES * PACKET_COUNT;
const HEADER_BYTES = 12;

function isImage(bytes, length) {
  return (length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
      && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10)
    || (length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46
      && bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61)
    || (length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50);
}

function imageError() {
  return Object.assign(new Error('分片返回图片，未找到有效视频数据。请重新检测视频后重试。'), {
    code: 'IMAGE_SEGMENT_NO_VIDEO', permanent: true
  });
}

function validTsRun(bytes, start) {
  let evidence = false;
  let continuityPairs = 0;
  const counters = new Map();
  for (let index = 0; index < PACKET_COUNT; index++) {
    const position = start + index * PACKET_BYTES;
    const end = position + PACKET_BYTES;
    if (bytes[position] !== 0x47 || (bytes[position + 1] & 0x80) || (bytes[position + 3] & 0xc0)) return false;
    const pid = ((bytes[position + 1] & 0x1f) << 8) | bytes[position + 2];
    const control = (bytes[position + 3] >> 4) & 3;
    if (!control) return false;
    let payload = position + 4;
    let discontinuity = false;
    if (control & 2) {
      const adaptationLength = bytes[payload];
      if ((control === 2 && adaptationLength !== 183) || (control === 3 && adaptationLength > 182)) return false;
      if (adaptationLength > 0) {
        const flags = bytes[payload + 1];
        const required = 1 + ((flags & 0x10) ? 6 : 0) + ((flags & 0x08) ? 6 : 0) + ((flags & 0x04) ? 1 : 0);
        if (adaptationLength < required) return false;
        discontinuity = Boolean(flags & 0x80);
      }
      payload += 1 + adaptationLength;
    }
    if (!(control & 1) || pid === 0x1fff) continue;
    if (payload >= end) return false;
    const counter = bytes[position + 3] & 15;
    if (!discontinuity && counters.has(pid) && counter === ((counters.get(pid) + 1) & 15)) continuityPairs++;
    counters.set(pid, counter);
    if (!(bytes[position + 1] & 0x40)) continue;
    // A plausible PES start, or a complete single-packet PAT/PMT section,
    // distinguishes media packets from coincidental sync bytes in an image.
    if (payload + 9 <= end && bytes[payload] === 0 && bytes[payload + 1] === 0 && bytes[payload + 2] === 1
      && (bytes[payload + 3] === 0xbd || (bytes[payload + 3] >= 0xc0 && bytes[payload + 3] <= 0xef))
      && (bytes[payload + 6] & 0xc0) === 0x80 && (bytes[payload + 7] & 0xc0) !== 0x40
      && payload + 9 + bytes[payload + 8] <= end) evidence = true;
    const section = payload + 1 + bytes[payload];
    if (section + 8 > end) continue;
    const table = bytes[section];
    const sectionLength = ((bytes[section + 1] & 15) << 8) | bytes[section + 2];
    if ((table === 0 && pid === 0 || table === 2 && pid > 0x0f)
      && (bytes[section + 1] & 0xf0) === 0xb0 && sectionLength >= (table === 0 ? 9 : 13)
      && sectionLength <= 1021 && section + 3 + sectionLength <= end
      && (bytes[section + 5] & 0xc0) === 0xc0 && bytes[section + 6] <= bytes[section + 7]) {
      let crc = 0xffffffff;
      for (let offset = section; offset < section + 3 + sectionLength; offset++) {
        crc ^= bytes[offset] << 24;
        for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? (crc << 1) ^ 0x04c11db7 : crc << 1;
      }
      if ((crc >>> 0) === 0) evidence = true;
    }
  }
  return evidence || continuityPairs >= 2;
}

/**
 * Repair only recognizable image-prefixed MPEG-TS, after AES decryption.
 * Unknown formats (including MP4 and ID3/AAC) are passed through unchanged.
 * Each instance owns one <=64 KiB sniff buffer and is safe to recreate per retry.
 */
export function createMediaSanitizeTransform({ onInfo = () => {}, expectedContainer = null } = {}) {
  if (typeof onInfo !== 'function') throw new TypeError('onInfo 必须是函数');
  if (![null, 'ts', 'mp4'].includes(expectedContainer)) throw new TypeError('媒体容器类型无效');
  let buffer = new Uint8Array(SNIFF_BYTES);
  let length = 0;
  let base = 0;
  let candidate = 1;
  let mode = 'header';

  function emit(bytes, controller) {
    for (let offset = 0; offset < bytes.byteLength; offset += OUTPUT_BYTES) {
      controller.enqueue(bytes.subarray(offset, Math.min(offset + OUTPUT_BYTES, bytes.byteLength)));
    }
  }

  function inspect(controller, final = false) {
    if (mode === 'header') {
      if (length < HEADER_BYTES && !final) return;
      if (!isImage(buffer, length)) {
        mode = 'pass';
        emit(buffer.subarray(0, length), controller);
        buffer = null;
        return;
      }
      mode = 'image';
    }
    // GIF's first byte is also the TS sync byte. Prefer a proven stream at
    // offset zero over the superficial GIF magic and never strip valid TS.
    if (base === 0 && length >= PROBE_BYTES && buffer[0] === 0x47 && validTsRun(buffer, 0)) {
      mode = 'pass';
      emit(buffer.subarray(0, length), controller);
      buffer = null;
      return;
    }
    const last = Math.min(SNIFF_BYTES, base + length - PROBE_BYTES);
    for (; candidate <= last; candidate++) {
      const local = candidate - base;
      if (expectedContainer !== 'mp4' && buffer[local] === 0x47 && validTsRun(buffer, local)) {
        mode = 'pass';
        onInfo({ container: 'mpegts', removedPrefixBytes: candidate, reason: 'image-prefix' });
        emit(buffer.subarray(local, length), controller);
        buffer = null;
        return;
      }
    }
    if (final || candidate > SNIFF_BYTES) throw imageError();
  }

  return new TransformStream({
    transform(chunk, controller) {
      if (!(chunk instanceof Uint8Array)) throw new TypeError('媒体数据必须是 Uint8Array');
      if (mode === 'pass') { emit(chunk, controller); return; }
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (length === buffer.byteLength) {
          // Discard rejected image bytes, preserving every incomplete candidate.
          // This also allows a prefix exactly 64 KiB long without a larger buffer.
          const drop = candidate - base;
          buffer.copyWithin(0, drop, length);
          length -= drop;
          base += drop;
        }
        const take = Math.min(chunk.byteLength - offset, buffer.byteLength - length,
          mode === 'header' ? HEADER_BYTES - length : 4096,
          SNIFF_BYTES + PROBE_BYTES - base - length);
        if (take <= 0) throw imageError();
        buffer.set(chunk.subarray(offset, offset + take), length);
        length += take;
        offset += take;
        inspect(controller);
        if (mode === 'pass') { emit(chunk.subarray(offset), controller); return; }
      }
    },
    flush(controller) { if (mode !== 'pass') inspect(controller, true); }
  });
}
