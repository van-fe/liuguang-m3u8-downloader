/** Parse HLS playlists without network or browser dependencies. */

function attributes(source) {
  const result = {};
  let index = 0;
  while (index < source.length) {
    while (source[index] === ',' || /\s/.test(source[index] || '')) index++;
    if (index >= source.length) break;
    const start = index;
    while (index < source.length && source[index] !== '=') index++;
    if (index === source.length) throw new Error('M3U8 属性缺少等号。');
    const name = source.slice(start, index).trim().toUpperCase();
    index++;
    while (/\s/.test(source[index] || '')) index++;
    let value;
    if (source[index] === '"') {
      index++;
      const valueStart = index;
      while (index < source.length && source[index] !== '"') index++;
      if (index === source.length) throw new Error('M3U8 属性的引号未闭合。');
      value = source.slice(valueStart, index++);
      while (/\s/.test(source[index] || '')) index++;
      if (index < source.length && source[index] !== ',') throw new Error('M3U8 属性之间缺少逗号。');
    } else {
      const valueStart = index;
      while (index < source.length && source[index] !== ',') index++;
      value = source.slice(valueStart, index).trim();
    }
    if (!name || Object.hasOwn(result, name)) throw new Error('M3U8 包含无效或重复的属性。');
    result[name] = value;
  }
  return result;
}

function absoluteUri(value, baseUrl) {
  if (!value) throw new Error('M3U8 中的资源地址为空。');
  let url;
  try { url = new URL(value, baseUrl); }
  catch { throw new Error('M3U8 中的资源地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('M3U8 仅支持 HTTP 或 HTTPS 资源。');
  return url.href;
}

function integer(value, label, minimum = 0) {
  if (!/^\d+$/.test(value || '')) throw new Error(`${label}必须是有效整数。`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`${label}超出允许范围。`);
  return parsed;
}

function byteRange(value, uri, previous) {
  const match = /^(\d+)(?:@(\d+))?$/.exec(value);
  if (!match) throw new Error('M3U8 字节范围格式无效。');
  const length = integer(match[1], '字节范围长度', 1);
  let offset;
  if (match[2] !== undefined) offset = integer(match[2], '字节范围偏移量');
  else if (previous?.uri === uri && previous.byteRange) offset = previous.byteRange.offset + previous.byteRange.length;
  else throw new Error('M3U8 隐式字节范围缺少同一资源的上一个范围。');
  if (!Number.isSafeInteger(offset + length)) throw new Error('M3U8 字节范围超出允许范围。');
  return { offset, length };
}

function parseIv(value) {
  if (value === undefined) return null;
  if (!/^0x[\da-f]{1,32}$/i.test(value)) throw new Error('AES-128 的 IV 必须是最多 128 位的十六进制数。');
  const hex = value.slice(2).padStart(32, '0');
  return Uint8Array.from({ length: 16 }, (_, index) => Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16));
}

function copyKey(key) {
  return key ? { ...key, iv: key.iv?.slice() ?? null } : null;
}

function copyMap(map) {
  return map ? { uri: map.uri, byteRange: map.byteRange ? { ...map.byteRange } : null, key: copyKey(map.key) } : null;
}

/**
 * Return a master playlist or a finite snapshot of a media playlist.
 * Encryption methods and key formats are preserved for the downloader to validate.
 */
export function parsePlaylist(text, baseUrl) {
  if (typeof text !== 'string') throw new Error('M3U8 播放列表必须是文本。');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('该地址没有返回有效的 M3U8 播放列表。');

  const variants = [];
  const audioRenditions = [];
  const segments = [];
  let pendingVariant = null;
  let pendingDuration = null;
  let pendingRange = null;
  let discontinuity = false;
  let gap = false;
  let key = null;
  let map = null;
  let previousMap = null;
  let mediaSequence = 0;
  let targetDuration = 0;
  let endList = false;

  for (const line of lines.slice(1)) {
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      if (pendingVariant) throw new Error('M3U8 清晰度列表缺少资源地址。');
      pendingVariant = attributes(line.slice(18));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = attributes(line.slice(13));
      if (attrs.TYPE === 'AUDIO') {
        audioRenditions.push({
          groupId: attrs['GROUP-ID'] || '',
          name: attrs.NAME || '',
          language: attrs.LANGUAGE || '',
          default: attrs.DEFAULT === 'YES',
          autoselect: attrs.AUTOSELECT === 'YES',
          uri: attrs.URI ? absoluteUri(attrs.URI, baseUrl) : null,
        });
      }
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      if (segments.length) throw new Error('M3U8 媒体序号必须位于分片之前。');
      mediaSequence = integer(line.slice(22).trim(), '媒体序号');
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = integer(line.slice(22).trim(), '目标分片时长', 1);
    } else if (line.startsWith('#EXTINF:')) {
      const value = line.slice(8).split(',')[0].trim();
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value))) {
        throw new Error('M3U8 分片时长无效。');
      }
      pendingDuration = Number(value);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(17).trim();
    } else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = attributes(line.slice(11));
      if (!attrs.METHOD) throw new Error('M3U8 密钥缺少加密方式。');
      key = attrs.METHOD === 'NONE' ? null : {
        method: attrs.METHOD,
        uri: attrs.URI ? absoluteUri(attrs.URI, baseUrl) : null,
        iv: parseIv(attrs.IV),
        keyFormat: attrs.KEYFORMAT || 'identity',
      };
      if (key?.method === 'AES-128' && key.keyFormat === 'identity' && !key.uri) {
        throw new Error('AES-128 播放列表缺少密钥地址。');
      }
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = attributes(line.slice(11));
      const uri = absoluteUri(attrs.URI, baseUrl);
      map = { uri, byteRange: attrs.BYTERANGE ? byteRange(attrs.BYTERANGE, uri, previousMap) : null, key: copyKey(key) };
      previousMap = map;
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity = true;
    } else if (line === '#EXT-X-GAP') {
      gap = true;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (line.startsWith('#EXT-X-SKIP:')) {
      throw new Error('此 M3U8 是增量播放列表，请使用包含完整分片的播放列表。');
    } else if (!line.startsWith('#')) {
      const uri = absoluteUri(line, baseUrl);
      if (pendingVariant) {
        const resolutionMatch = /^(\d+)x(\d+)$/i.exec(pendingVariant.RESOLUTION || '');
        variants.push({
          uri,
          bandwidth: Number(pendingVariant['AVERAGE-BANDWIDTH'] || pendingVariant.BANDWIDTH) || 0,
          resolution: resolutionMatch ? { width: Number(resolutionMatch[1]), height: Number(resolutionMatch[2]) } : null,
          codecs: pendingVariant.CODECS || '',
          audioGroup: pendingVariant.AUDIO || null,
          name: pendingVariant.NAME || '',
        });
        pendingVariant = null;
      } else {
        if (pendingDuration === null) throw new Error('M3U8 分片缺少 EXTINF 时长。');
        const sequence = mediaSequence + segments.length;
        if (!Number.isSafeInteger(sequence)) throw new Error('M3U8 媒体序号超出允许范围。');
        segments.push({
          uri,
          duration: pendingDuration,
          sequence,
          key: copyKey(key),
          map: copyMap(map),
          byteRange: pendingRange ? byteRange(pendingRange, uri, segments.at(-1)) : null,
          discontinuity,
          gap,
        });
        pendingDuration = null;
        pendingRange = null;
        discontinuity = false;
        gap = false;
      }
    }
  }
  if (pendingVariant) throw new Error('M3U8 清晰度列表缺少资源地址。');
  if (pendingDuration !== null || pendingRange !== null) throw new Error('M3U8 末尾的分片缺少资源地址。');
  if (variants.length && segments.length) throw new Error('M3U8 混合了主播放列表与媒体分片。');
  if (variants.length) return { kind: 'master', variants, audioRenditions };
  if (!segments.length) throw new Error('M3U8 中没有可下载的完整视频分片。');
  return { kind: 'media', segments, endList, targetDuration, mediaSequence, duration: segments.reduce((total, segment) => total + segment.duration, 0) };
}

/** Select a variant by exact URL, preferred vertical resolution, or highest quality. */
export function chooseVariant(variants, preferred = 'best') {
  if (!Array.isArray(variants) || !variants.length) throw new Error('没有可用的视频清晰度。');
  const byUri = variants.find(variant => variant.uri === preferred);
  if (byUri) return byUri;
  const ranked = [...variants].sort((left, right) =>
    (right.resolution?.height || 0) - (left.resolution?.height || 0)
    || (right.resolution?.width || 0) - (left.resolution?.width || 0)
    || right.bandwidth - left.bandwidth);
  const height = Number.parseInt(preferred, 10);
  if (Number.isFinite(height) && height > 0) return ranked.find(variant => variant.resolution?.height <= height) || ranked.at(-1);
  return ranked[0];
}

/** Make an MP4 filename that is valid on Windows/macOS/Linux. */
export function sanitizeFilename(name) {
  let value = String(name || '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_').trim().replace(/[. ]+$/g, '');
  value = value.replace(/\.mp4$/i, '').replace(/[. ]+$/g, '');
  if (!value) value = 'video';
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(value)) value = `_${value}`;
  value = Array.from(value).slice(0, 120).join('').replace(/[. ]+$/g, '');
  return `${value}.mp4`;
}
