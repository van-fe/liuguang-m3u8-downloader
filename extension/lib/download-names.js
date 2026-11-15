export const DOWNLOAD_NAMES_STORAGE_KEY = 'liuguangDownloadNamesV1';
export const DOWNLOAD_NAME_TTL_MS = 10 * 60 * 1000;

/** A Blob belonging to this exact extension, never a remote or lookalike URL. */
export function isOwnDownloadBlob(value, extensionId) {
  if (typeof value !== 'string' || value.length > 1024 || !value.startsWith('blob:')) return false;
  try {
    const inner = new URL(value.slice(5));
    return inner.protocol === 'chrome-extension:' && inner.hostname === extensionId &&
      !inner.username && !inner.password && !inner.port && !inner.search && !inner.hash &&
      /^\/[^/]+$/.test(inner.pathname);
  } catch { return false; }
}

/** Keep only a safe basename; the download itself owns its file extension. */
export function sanitizeDownloadName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('下载文件名不能为空。');
  let name = value.normalize('NFC').trim().replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '_').replace(/[. ]+$/g, '');
  if (!name) throw new Error('下载文件名无效。');
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(name)) name = `_${name}`;
  const extension = /\.[a-z0-9]{1,10}$/i.exec(name)?.[0] || '';
  const stem = extension ? name.slice(0, -extension.length) : name;
  name = Array.from(stem).slice(0, 180 - extension.length).join('').replace(/[. ]+$/g, '') + extension;
  return name;
}

/** Persist pending download registrations until completion or expiry, including across worker restarts. */
export function createDownloadNameStore(storageArea, { extensionId, now = Date.now } = {}) {
  if (!storageArea?.get || !storageArea?.set || typeof extensionId !== 'string' || !extensionId) {
    throw new TypeError('缺少下载命名存储接口。');
  }
  let pending = Promise.resolve();
  const run = callback => {
    const operation = pending.then(callback);
    pending = operation.catch(() => {});
    return operation;
  };
  const read = async () => {
    const saved = (await storageArea.get(DOWNLOAD_NAMES_STORAGE_KEY))[DOWNLOAD_NAMES_STORAGE_KEY];
    const current = now();
    const entries = new Map();
    for (const value of Array.isArray(saved) ? saved : []) {
      if (!value || !isOwnDownloadBlob(value.url, extensionId) ||
          typeof value.jobId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(value.jobId) || value.phase !== 'anchor' ||
          !Number.isFinite(value.createdAt) || !Number.isFinite(value.expiresAt) ||
          value.createdAt > current || value.expiresAt <= current ||
          value.expiresAt > value.createdAt + DOWNLOAD_NAME_TTL_MS) continue;
      let filename;
      try { filename = sanitizeDownloadName(value.filename); } catch { continue; }
      entries.set(value.url, {
        url: value.url, filename, jobId: value.jobId, phase: 'anchor', createdAt: value.createdAt, expiresAt: value.expiresAt,
        ...(Number.isInteger(value.downloadId) && value.downloadId >= 0 ? { downloadId: value.downloadId } : {})
      });
    }
    return [...entries.values()].sort((a, b) => a.createdAt - b.createdAt);
  };
  const write = entries => storageArea.set({ [DOWNLOAD_NAMES_STORAGE_KEY]: entries });
  return {
    register(url, filename, jobId) {
      if (!isOwnDownloadBlob(url, extensionId)) return Promise.reject(new Error('无效的本地下载文件。'));
      if (typeof jobId !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(jobId)) return Promise.reject(new Error('下载任务编号无效。'));
      let safeName;
      try { safeName = sanitizeDownloadName(filename); } catch (error) { return Promise.reject(error); }
      return run(async () => {
        const entries = (await read()).filter(entry => entry.url !== url);
        const timestamp = now();
        entries.push({ url, filename: safeName, jobId, phase: 'anchor', createdAt: timestamp, expiresAt: timestamp + DOWNLOAD_NAME_TTL_MS });
        await write(entries);
        return safeName;
      });
    },
    match(item) {
      if (!item || (item.byExtensionId != null && item.byExtensionId !== extensionId) ||
          !Number.isInteger(item.id) || item.id < 0 || !isOwnDownloadBlob(item.url, extensionId)) return Promise.resolve(null);
      return run(async () => {
        const entries = await read();
        const entry = entries.find(value => value.url === item.url);
        if (!entry) return null;
        if (entry.downloadId != null && entry.downloadId !== item.id) return null;
        entry.downloadId = item.id;
        await write(entries);
        return { ...entry };
      });
    },
    remove(url) {
      return run(async () => {
        const entries = await read();
        const remaining = entries.filter(entry => entry.url !== url);
        if (remaining.length !== entries.length) await write(remaining);
      });
    },
    complete(downloadId) {
      return run(async () => {
        const entries = await read();
        const remaining = entries.filter(entry => entry.downloadId !== downloadId);
        if (remaining.length !== entries.length) await write(remaining);
      });
    }
  };
}
