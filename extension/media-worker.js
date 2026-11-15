import createFFmpegCore from './vendor/ffmpeg-core/ffmpeg-core.js';
import { createOPFSFilesystem } from './lib/opfs-fs.js';

// The upstream FFmpeg client protocol, with a disk-backed output mount.
// WORKERFS inputs only read the requested Blob slices into the WASM heap.
let core;
const diskMounts = new Map();
let messages = Promise.resolve();

async function dispatch(type, data) {
  if (type === 'LOAD') {
    if (core) return false;
    core = await createFFmpegCore({
      mainScriptUrlOrBlob: `${data.coreURL}#${btoa(JSON.stringify({ wasmURL: data.wasmURL }))}`
    });
    core.setLogger(data => self.postMessage({ type: 'LOG', data }));
    core.setProgress(data => self.postMessage({ type: 'PROGRESS', data }));
    return true;
  }
  if (!core) throw new Error('媒体引擎尚未加载');
  const FS = core.FS;
  switch (type) {
    case 'MOUNT': {
      if (data.fsType === 'OPFS') {
        const access = await data.options.fileHandle.createSyncAccessHandle();
        try {
          FS.mount(createOPFSFilesystem(FS, access, 'output.mp4'), {}, data.mountPoint);
          diskMounts.set(data.mountPoint, access);
        } catch (error) { access.close(); throw error; }
        return true;
      }
      const filesystem = FS.filesystems[data.fsType];
      if (!filesystem) throw new Error(`不支持的文件系统：${data.fsType}`);
      FS.mount(filesystem, data.options, data.mountPoint);
      return true;
    }
    case 'UNMOUNT': {
      FS.unmount(data.mountPoint);
      const access = diskMounts.get(data.mountPoint);
      if (access) {
        try { access.flush(); } finally { access.close(); diskMounts.delete(data.mountPoint); }
      }
      return true;
    }
    case 'EXEC':
    case 'FFPROBE': {
      core.setTimeout(data.timeout ?? -1);
      try {
        core[type === 'EXEC' ? 'exec' : 'ffprobe'](...data.args);
        for (const access of diskMounts.values()) access.flush();
        return core.ret;
      } finally { core.reset(); }
    }
    case 'CREATE_DIR': FS.mkdir(data.path); return true;
    case 'DELETE_DIR': FS.rmdir(data.path); return true;
    case 'WRITE_FILE': FS.writeFile(data.path, data.data); return true;
    case 'READ_FILE': return FS.readFile(data.path, { encoding: data.encoding });
    case 'DELETE_FILE': FS.unlink(data.path); return true;
    case 'RENAME': FS.rename(data.oldPath, data.newPath); return true;
    case 'LIST_DIR': return FS.readdir(data.path).map(name => ({ name, isDir: FS.isDir(FS.stat(`${data.path}/${name}`).mode) }));
    default: throw new Error(`未知的媒体引擎操作：${type}`);
  }
}

self.onmessage = ({ data: { id, type, data } }) => {
  messages = messages.catch(() => {}).then(async () => {
    try {
      const result = await dispatch(type, data);
      self.postMessage({ id, type, data: result }, result instanceof Uint8Array ? [result.buffer] : []);
    } catch (error) {
      self.postMessage({ id, type: 'ERROR', data: `${error.name || 'Error'}: ${error.message || error}` });
    }
  });
};
