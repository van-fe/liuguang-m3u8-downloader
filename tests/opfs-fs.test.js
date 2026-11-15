import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createFFmpegCore from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js';
import { createOPFSFilesystem } from '../extension/lib/opfs-fs.js';

// Sparse storage exercises real Emscripten FS without allocating a multi-GB array.
class SparseAccessHandle {
  size = 0;
  blocks = new Map();
  flushes = 0;
  maxWrite = Infinity;
  closed = false;
  getSize() { assert.equal(this.closed, false); return this.size; }
  truncate(size) {
    assert.equal(this.closed, false);
    for (const offset of this.blocks.keys()) if (offset >= size) this.blocks.delete(offset);
    this.size = size;
  }
  read(buffer, { at }) {
    assert.equal(this.closed, false);
    const count = Math.min(buffer.byteLength, Math.max(0, this.size - at));
    for (let index = 0; index < count; index++) buffer[index] = this.blocks.get(at + index) || 0;
    return count;
  }
  write(buffer, { at }) {
    assert.equal(this.closed, false);
    const count = Math.min(buffer.byteLength, this.maxWrite);
    for (let index = 0; index < count; index++) this.blocks.set(at + index, buffer[index]);
    this.size = Math.max(this.size, at + count);
    return count;
  }
  flush() { assert.equal(this.closed, false); this.flushes++; }
  close() { this.closed = true; }
}

async function actualCore() {
  // This distributed core targets workers. These are the only browser globals
  // needed when wasmBinary is supplied and WORKERFS is not mounted in this test.
  globalThis.self ||= { location: { href: import.meta.url } };
  const wasmBinary = await readFile(new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url));
  return createFFmpegCore({ wasmBinary });
}

const corePromise = actualCore();
let sequence = 0;
async function mounted(handle = new SparseAccessHandle()) {
  const core = await corePromise;
  const mountpoint = `/opfs-${++sequence}`;
  core.FS.mkdir(mountpoint);
  core.FS.mount(createOPFSFilesystem(core.FS, handle), {}, mountpoint);
  return { core, FS: core.FS, handle, mountpoint, path: `${mountpoint}/output.mp4` };
}

test('actual core reads and writes beyond 4 GiB without offset wrapping', async () => {
  const { FS, handle, mountpoint, path } = await mounted();
  const stream = FS.open(path, 'w+');
  const largeOffset = 5 * 1024 ** 3 + 27;
  assert.equal(FS.llseek(stream, largeOffset, 0), largeOffset);
  assert.equal(FS.write(stream, new Uint8Array([3, 8, 21]), 0, 3), 3);
  assert.equal(FS.stat(path).size, largeOffset + 3);
  assert.equal(FS.llseek(stream, -3, 2), largeOffset);
  const bytes = new Uint8Array(3);
  assert.equal(FS.read(stream, bytes, 0, 3), 3);
  assert.deepEqual([...bytes], [3, 8, 21]);
  assert.equal(FS.llseek(stream, -3, 1), largeOffset);
  FS.close(stream);
  assert.equal(handle.closed, false);
  FS.unmount(mountpoint);
});

test('actual core supports truncate, partial writes, EOF, and reopening after close', async () => {
  const { FS, handle, mountpoint, path } = await mounted();
  handle.maxWrite = 2;
  const stream = FS.open(path, 'w+');
  const wrapped = new Uint8Array([99, 7, 11, 19, 23, 99]);
  assert.equal(FS.write(stream, wrapped, 1, 4), 4);
  assert.equal(FS.stat(path).size, 4);
  FS.close(stream);
  const reopened = FS.open(path, 'r');
  const bytes = new Uint8Array(8);
  assert.equal(FS.read(reopened, bytes, 2, 6), 4);
  assert.deepEqual([...bytes], [0, 0, 7, 11, 19, 23, 0, 0]);
  assert.equal(FS.read(reopened, bytes, 0, 8), 0);
  FS.close(reopened);
  const truncated = FS.open(path, 'w');
  assert.equal(FS.stat(path).size, 0);
  FS.close(truncated);
  assert.ok(handle.flushes >= 3);
  FS.unmount(mountpoint);
});

test('adapter exposes directory and maps quota/short-write errors to POSIX errno', async () => {
  const { FS, handle, mountpoint, path } = await mounted();
  assert.deepEqual(FS.readdir(mountpoint), ['.', '..', 'output.mp4']);
  assert.throws(() => FS.open(`${mountpoint}/absent.mp4`, 'r'), error => error.errno === 44);
  const stream = FS.open(path, 'w+');
  handle.write = () => { throw new DOMException('Disk full', 'QuotaExceededError'); };
  assert.throws(() => FS.write(stream, new Uint8Array(2), 0, 2), error => error.errno === 51 && error.message === 'Disk full');
  handle.write = () => 0;
  assert.throws(() => FS.write(stream, new Uint8Array(2), 0, 2), error => error.errno === 29);
  assert.throws(() => FS.llseek(stream, -1, 0), error => error.errno === 28);
  assert.throws(() => FS.llseek(stream, Number.MAX_SAFE_INTEGER + 1, 0), error => error.errno === 28);
  FS.close(stream);
  FS.unmount(mountpoint);
});

test('actual FFmpeg creates MP4 with faststart through random disk access adapter', async () => {
  const { core, FS, handle, mountpoint, path } = await mounted();
  const logs = [];
  core.setLogger(({ message }) => logs.push(message));
  core.exec('-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=2',
    '-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path);
  const exitCode = core.ret;
  core.reset();
  assert.equal(exitCode, 0, logs.join('\n'));
  assert.ok(handle.size > 500);
  const stream = FS.open(path, 'r');
  const header = new Uint8Array(Math.min(handle.size, 4096));
  FS.read(stream, header, 0, header.byteLength);
  FS.close(stream);
  const text = new TextDecoder('latin1').decode(header);
  assert.equal(text.slice(4, 8), 'ftyp');
  assert.ok(text.indexOf('moov') > 0);
  assert.ok(text.indexOf('mdat') > text.indexOf('moov'));
  assert.equal(handle.closed, false);
  FS.unmount(mountpoint);
});
