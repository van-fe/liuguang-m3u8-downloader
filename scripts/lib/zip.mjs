import { readFile, writeFile } from 'node:fs/promises';
import { deflateRawSync } from 'node:zlib';

const table = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = table[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Create a deterministic, UTF-8, standard ZIP without system archivers. */
export async function writeZip(destination, entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const names = new Set();
  const sorted = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (sorted.length > 65535) throw new Error('ZIP entry count exceeds standard ZIP capacity.');
  for (const entry of sorted) {
    const name = entry.name.replace(/\\/g, '/');
    if (!name || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..') || names.has(name)) {
      throw new Error(`Invalid or duplicate ZIP path: ${name}`);
    }
    names.add(name);
    const bytes = entry.bytes == null ? await readFile(entry.source) : Buffer.from(entry.bytes);
    const compressed = deflateRawSync(bytes, { level: 9 });
    const filename = Buffer.from(name, 'utf8');
    const crc = crc32(bytes);
    if (Math.max(offset, bytes.length, compressed.length) > 0xffffffff || filename.length > 65535) throw new Error('ZIP64 is not supported.');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
    // Fixed 2000-01-01 date makes identical input produce identical archives.
    header.writeUInt16LE(10273, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
    localParts.push(header, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(10273, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(centralParts);
  if (offset + directory.length > 0xffffffff) throw new Error('ZIP64 is not supported.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(sorted.length, 8); end.writeUInt16LE(sorted.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  await writeFile(destination, Buffer.concat([...localParts, directory, end]));
  return sorted.length;
}
