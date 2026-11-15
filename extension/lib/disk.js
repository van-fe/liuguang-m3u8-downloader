const CACHE_DIRECTORY = 'liuguang-download-cache-v1';

function validName(name) {
  if (!/^[a-zA-Z0-9._-]+$/.test(name) || name === '.' || name === '..') throw new Error('无效的缓存文件名');
  return name;
}

async function cacheRoot() {
  if (!navigator.storage?.getDirectory) throw new Error('此 Chrome 版本不支持本地磁盘缓存，请更新浏览器。');
  return (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIRECTORY, { create: true });
}

/** Only the extension's own staging directory is touched. */
export async function cleanupAbandonedDownloads() {
  const root = await cacheRoot();
  for await (const [name] of root.entries()) {
    await root.removeEntry(name, { recursive: true }).catch(error => {
      console.warn('无法清理上次中断的下载缓存', name, error.name);
    });
  }
}

export async function createDownloadDisk(jobId) {
  const root = await cacheRoot();
  const name = validName(jobId);
  const directory = await root.getDirectoryHandle(name, { create: true });
  const input = await directory.getDirectoryHandle('input', { create: true });
  const output = await directory.getFileHandle('output.mp4', { create: true });
  return {
    output,
    async createOutputSink() {
      const stream = await output.createWritable();
      return { write: bytes => stream.write(bytes), close: () => stream.close(), abort: reason => stream.abort(reason) };
    },
    async createSink(filename) {
      const handle = await input.getFileHandle(validName(filename), { create: true });
      // A failed attempt is aborted. A fresh writable starts empty for the retry.
      const stream = await handle.createWritable();
      return { write: bytes => stream.write(bytes), close: () => stream.close(), abort: reason => stream.abort(reason) };
    },
    async writeFile(filename, data) {
      const sink = await this.createSink(filename);
      try { await sink.write(data); await sink.close(); }
      catch (error) { await sink.abort(error).catch(() => {}); throw error; }
    },
    async files() {
      const files = [];
      for await (const handle of input.values()) if (handle.kind === 'file') files.push(await handle.getFile());
      return files;
    },
    async clearInputs() { await directory.removeEntry('input', { recursive: true }); },
    async remove() {
      for (let attempt = 0; attempt < 4; attempt++) {
        try { await root.removeEntry(name, { recursive: true }); return; }
        catch (error) {
          if (error.name === 'NotFoundError') return;
          if (attempt === 3) { console.warn('下载缓存将于下次启动时清理', name, error.name); return; }
          await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
        }
      }
    }
  };
}

export function explainDiskError(error) {
  const message = error?.message || String(error);
  if (/quota|space|ENOSPC|disk.*full|storage.*full|ErrnoError:.*51|磁盘空间不足/i.test(`${error?.name || ''} ${message}`)) {
    return '本地磁盘空间不足。请清理 Chrome 缓存所在磁盘及下载目标磁盘后重试；大视频处理建议预留至少视频大小 3 倍的可用空间。';
  }
  return message;
}
