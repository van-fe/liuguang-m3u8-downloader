// Emscripten's synchronous file callbacks run inside the FFmpeg dedicated worker.
// File positions stay as JavaScript numbers; converting them to 32-bit integers
// would corrupt files as soon as an offset crossed 2 or 4 GiB.
const ERRNO = { EACCES: 2, EEXIST: 20, EINVAL: 28, EIO: 29, EISDIR: 31, ENOENT: 44, ENOSPC: 51, ENOTDIR: 54, EPERM: 63 };

export function createOPFSFilesystem(FS, accessHandle, filename = 'output.mp4') {
  if (!filename || /[/\\]/.test(filename) || filename === '.' || filename === '..') {
    throw new TypeError('输出文件名无效。');
  }

  function fail(code, cause) {
    const error = new FS.ErrnoError(code);
    if (cause?.message) error.message = cause.message;
    if (cause) error.cause = cause;
    throw error;
  }

  function io(callback) {
    try { return callback(); }
    catch (error) {
      if (error?.name === 'ErrnoError') throw error;
      const code = error?.name === 'QuotaExceededError' ? ERRNO.ENOSPC
        : error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? ERRNO.EACCES
        : error instanceof RangeError || error?.name === 'TypeError' ? ERRNO.EINVAL
        : ERRNO.EIO;
      return fail(code, error);
    }
  }

  function position(value) {
    if (!Number.isSafeInteger(value) || value < 0) fail(ERRNO.EINVAL);
    return value;
  }

  function view(buffer, offset, length) {
    position(offset);
    position(length);
    if (offset + length > buffer.byteLength) fail(ERRNO.EINVAL);
    return new Uint8Array(buffer.buffer, buffer.byteOffset + offset, length);
  }

  const nodeOps = {
    getattr(node) {
      const size = FS.isDir(node.mode) ? 4096 : io(() => accessHandle.getSize());
      const time = new Date(node.timestamp);
      return {
        dev: 1, ino: node.id, mode: node.mode, nlink: 1, uid: 0, gid: 0,
        rdev: 0, size, atime: time, mtime: time, ctime: time,
        blksize: 4096, blocks: Math.ceil(size / 4096)
      };
    },
    setattr(node, attributes) {
      if (attributes.size !== undefined) {
        if (FS.isDir(node.mode)) fail(ERRNO.EISDIR);
        io(() => accessHandle.truncate(position(attributes.size)));
      }
      if (attributes.mode !== undefined) node.mode = attributes.mode;
      if (attributes.timestamp !== undefined) node.timestamp = attributes.timestamp;
    },
    lookup(parent, name) {
      if (!FS.isDir(parent.mode)) fail(ERRNO.ENOTDIR);
      const child = parent.contents[name];
      if (!child) fail(ERRNO.ENOENT);
      return child;
    },
    readdir(node) {
      if (!FS.isDir(node.mode)) fail(ERRNO.ENOTDIR);
      return ['.', '..', ...Object.keys(node.contents)];
    },
    mknod(parent, name) {
      if (parent.contents[name]) fail(ERRNO.EEXIST);
      fail(ERRNO.EPERM);
    },
    unlink() { fail(ERRNO.EPERM); },
    rmdir() { fail(ERRNO.EPERM); },
    rename() { fail(ERRNO.EPERM); }
  };

  const streamOps = {
    read(stream, buffer, offset, length, filePosition) {
      if (FS.isDir(stream.node.mode)) fail(ERRNO.EISDIR);
      return io(() => accessHandle.read(view(buffer, offset, length), { at: position(filePosition) }));
    },
    write(stream, buffer, offset, length, filePosition) {
      if (FS.isDir(stream.node.mode)) fail(ERRNO.EISDIR);
      const bytes = view(buffer, offset, length);
      position(filePosition);
      position(filePosition + length);
      let written = 0;
      while (written < bytes.byteLength) {
        const count = io(() => accessHandle.write(bytes.subarray(written), { at: filePosition + written }));
        if (!Number.isSafeInteger(count) || count <= 0 || count > bytes.byteLength - written) fail(ERRNO.EIO);
        written += count;
      }
      stream.node.timestamp = Date.now();
      return written;
    },
    llseek(stream, offset, whence) {
      if (!Number.isSafeInteger(offset)) fail(ERRNO.EINVAL);
      if (whence === 0) return position(offset);
      if (whence === 1) return position(stream.position + offset);
      if (whence === 2) return position(io(() => accessHandle.getSize()) + offset);
      return fail(ERRNO.EINVAL);
    },
    fsync() { io(() => accessHandle.flush()); return 0; },
    // FFmpeg faststart closes and reopens the output, including a read stream.
    // The worker owns the handle lifetime and closes it only after exec/unmount.
    close() { io(() => accessHandle.flush()); }
  };

  return {
    mount() {
      const root = FS.createNode(null, '/', 0o40777, 0);
      root.node_ops = nodeOps;
      root.stream_ops = streamOps;
      root.timestamp = Date.now();
      root.contents = Object.create(null);
      const file = FS.createNode(root, filename, 0o100666, 0);
      file.node_ops = nodeOps;
      file.stream_ops = streamOps;
      file.timestamp = Date.now();
      root.contents[filename] = file;
      return root;
    }
  };
}
