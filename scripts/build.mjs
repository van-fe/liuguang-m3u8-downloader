import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'dist', 'liuguang-m3u8');
await mkdir(output, { recursive: true });
await cp(path.join(root, 'extension'), output, { recursive: true, force: true });
// Directory authorization now stays in the popup. Remove the three retired
// pages from earlier builds so an upgrade cannot leave the old screen behind.
for (const name of ['local-rename.html', 'local-rename.css', 'local-rename.js']) {
  await rm(path.join(output, name), { force: true });
}
// The MAIN-world observer cannot use ES module imports. Its only dependency is
// our import-free parser, so package both in one isolated classic-script scope.
const xParser = (await readFile(path.join(root, 'extension', 'lib', 'x-media.js'), 'utf8')).replace(/^export\s+/gm, '');
const xObserver = (await readFile(path.join(root, 'extension', 'x-observer.js'), 'utf8')).replace(/^import[^\r\n]*;\s*$/gm, '');
if (/^\s*(?:import|export)\s/m.test(xParser + xObserver)) throw new Error('X observer bundle contains an unresolved module import or export');
await writeFile(path.join(output, 'x-observer.js'), `(() => {\n${xParser}\n${xObserver}\n})();\n`);
await cp(path.join(root, 'licenses'), path.join(output, 'licenses'), { recursive: true, force: true });
await mkdir(path.join(output, 'vendor', 'hls'), { recursive: true });
await cp(path.join(root, 'node_modules', 'hls.js', 'dist', 'hls.min.js'), path.join(output, 'vendor', 'hls', 'hls.min.js'));
await cp(path.join(root, 'node_modules', 'hls.js', 'LICENSE'), path.join(output, 'licenses', 'hls.js-LICENSE'));
for (const [name, destination] of [['@ffmpeg/ffmpeg', 'ffmpeg'], ['@ffmpeg/core', 'ffmpeg-core']]) {
  await cp(path.join(root, 'node_modules', name, 'dist', 'esm'), path.join(output, 'vendor', destination), { recursive: true });
  const packageRoot = path.join(root, 'node_modules', name);
  const files = await readdir(packageRoot);
  for (const file of files.filter(file => /^(license|copying)/i.test(file))) {
    await mkdir(path.join(output, 'licenses', destination), { recursive: true });
    await cp(path.join(packageRoot, file), path.join(output, 'licenses', destination, file));
  }
  await cp(path.join(packageRoot, 'package.json'), path.join(output, 'vendor', destination, 'package.json'));
}
for (const file of ['README.md', 'THIRD_PARTY_NOTICES.md', 'SITE_TEST_RESULTS.md', 'LICENSE', 'COPYRIGHT']) {
  await cp(path.join(root, file), path.join(output, file));
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = data => {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};
const chunk = (name, data) => {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
};
await mkdir(path.join(output, 'assets'), { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const data = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (x + 0.5) / size, ny = (y + 0.5) / size;
    const inside = Math.hypot(Math.max(Math.abs(nx - 0.5) - 0.26, 0), Math.max(Math.abs(ny - 0.5) - 0.26, 0)) < 0.20;
    const triangle = nx >= 0.39 && nx <= 0.72 && Math.abs(ny - 0.5) <= (0.72 - nx) * 0.75;
    const i = y * (size * 4 + 1) + 1 + x * 4;
    data.set(triangle ? [243, 249, 246, 255] : [23, 101, 94, inside ? 255 : 0], i);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  await writeFile(path.join(output, 'assets', `icon${size}.png`), Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(data)), chunk('IEND', Buffer.alloc(0))]));
}

const entries = [];
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), `${name}/`);
    else entries.push({ name, bytes: await readFile(path.join(directory, entry.name)) });
  }
}
await collect(output);
const locals = [], central = [];
let offset = 0;
for (const { name, bytes } of entries) {
  const filename = Buffer.from(name);
  const compressed = deflateRawSync(bytes);
  const crc = crc32(bytes);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
  locals.push(local, filename, compressed);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x800, 8); record.writeUInt16LE(8, 10);
  record.writeUInt32LE(crc, 16); record.writeUInt32LE(compressed.length, 20); record.writeUInt32LE(bytes.length, 24); record.writeUInt16LE(filename.length, 28); record.writeUInt32LE(offset, 42);
  central.push(record, filename);
  offset += local.length + filename.length + compressed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
const archive = path.join(root, 'dist', 'liuguang-m3u8.zip');
await writeFile(archive, Buffer.concat([...locals, directory, end]));
console.log(`插件目录：${output}\n安装包：${archive}\n文件数量：${entries.length}`);
