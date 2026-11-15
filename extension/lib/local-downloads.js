import { sanitizeFilename } from './hls.js';

const DATABASE = 'liuguang-local-files';
const DIRECTORY_STORE = 'directories';
let databasePromise;

export class LocalDirectoryAuthorizationRequired extends Error {
  constructor() {
    super('请先选择文件所在文件夹，并允许插件修改其中的文件。');
    this.name = 'LocalDirectoryAuthorizationRequired';
    this.code = 'LOCAL_DIRECTORY_AUTHORIZATION_REQUIRED';
  }
}

function localPath(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f]/.test(value)) throw new Error('无法确定已下载文件的位置。');
  const windows = /^(?:[a-z]:[\\/]|\\\\)/i.test(value);
  if (!windows && !value.startsWith('/')) throw new Error('无法确定已下载文件的位置。');
  const separator = windows ? '\\' : '/';
  const path = windows ? value.replace(/\//g, '\\') : value;
  const index = path.lastIndexOf(separator);
  const filename = path.slice(index + 1);
  if (!filename || filename === '.' || filename === '..') throw new Error('无法确定已下载文件的位置。');
  const directoryPath = index === 0 ? '/' : index === 2 && windows ? path.slice(0, 3) : path.slice(0, index);
  const directoryName = directoryPath.replace(/[\\/]+$/g, '').split(separator).at(-1);
  return { path, directoryPath, directoryName, currentFilename: filename, separator, windows };
}

function directoryKey(value) {
  const info = localPath(`${value.replace(/[\\/]+$/g, '')}/_`);
  return info.windows ? info.directoryPath.toLowerCase() : info.directoryPath;
}

function database() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(DIRECTORY_STORE);
    open.onerror = () => reject(new Error('无法保存文件夹授权，请重新打开插件后重试。'));
    open.onsuccess = () => resolve(open.result);
  }).catch(error => { databasePromise = null; throw error; });
  return databasePromise;
}

export async function getSavedDirectory(directoryPath) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(DIRECTORY_STORE, 'readonly');
    const request = transaction.objectStore(DIRECTORY_STORE).get(directoryKey(directoryPath));
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('无法读取文件夹授权，请重新选择文件夹。'));
  });
}

export async function saveDirectory(directoryPath, handle) {
  if (handle?.kind !== 'directory') throw new Error('请选择文件所在文件夹。');
  const info = localPath(`${directoryPath.replace(/[\\/]+$/g, '')}/_`);
  const matches = info.windows ? handle.name.toLowerCase() === info.directoryName.toLowerCase() : handle.name === info.directoryName;
  if (!matches) throw new Error('所选文件夹与文件所在文件夹不同，请选择页面上显示的文件夹。');
  if (await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new LocalDirectoryAuthorizationRequired();
  const db = await database();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(DIRECTORY_STORE, 'readwrite');
    transaction.objectStore(DIRECTORY_STORE).put(handle, directoryKey(directoryPath));
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () => reject(new Error('无法保存文件夹授权，请重试。'));
  });
}

/** Chrome supplies the actual name, including save-dialog edits and uniquifying suffixes. */
export async function getLocalDownloadInfo(job, { downloads = globalThis.chrome?.downloads } = {}) {
  if (job?.status !== 'complete') throw new Error('只有已下载完成的文件可以在本地改名。');
  let path = job.localFilePath;
  let size = job.localFileSize;
  if (!path) {
    if (!Number.isInteger(job.downloadId)) throw new Error('找不到此任务的本地下载记录，请在文件夹中确认文件。');
    const [download] = await downloads.search({ id: job.downloadId });
    if (!download || download.exists === false) throw new Error('已下载的文件不存在或已被移走。');
    if (download.state !== 'complete') throw new Error('文件尚未保存完成，请稍后重试。');
    path = download.filename;
    size = download.fileSize;
  }
  const info = localPath(path);
  return { ...info, currentPath: info.path, size: Number.isSafeInteger(size) && size >= 0 ? size : null };
}

/** Restore an already selected directory only from the user's visible UI action.
 * A saved handle may survive after Chrome resets its live permission to prompt.
 * The background must still query permission again before touching the file.
 */
export async function restoreLocalDownloadPermission(job, options = {}) {
  const info = await getLocalDownloadInfo(job, options);
  const directory = await (options.getDirectory || getSavedDirectory)(info.directoryPath);
  if (!directory) return { available: false, granted: false };
  let permission;
  try { permission = await directory.queryPermission({ mode: 'readwrite' }); }
  catch {
    const error = new Error('无法读取文件夹权限，请重新授权后再改名。');
    error.code = 'LOCAL_PERMISSION_RESTORE_FAILED';
    throw error;
  }
  if (permission === 'granted') return { available: true, granted: true, permission };
  // A deliberate denial must not trigger repeated requests on every rename.
  if (permission !== 'prompt') return { available: true, granted: false, permission };
  const active = typeof options.userActivation === 'function'
    ? options.userActivation()
    : options.userActivation ?? globalThis.navigator?.userActivation?.isActive;
  if (active !== true) return { available: true, granted: false, permission, requiresUserActivation: true };
  try { permission = await directory.requestPermission({ mode: 'readwrite' }); }
  catch {
    const error = new Error('未能恢复文件夹权限，原文件名保持不变，请重新授权后再试。');
    error.code = 'LOCAL_PERMISSION_RESTORE_FAILED';
    throw error;
  }
  return { available: true, granted: permission === 'granted', permission };
}

/** Rename through the browser's native move operation; never copy the video or remove it. */
export async function renameLocalDownload(job, title, options = {}) {
  const info = await getLocalDownloadInfo(job, options);
  const directory = await (options.getDirectory || getSavedDirectory)(info.directoryPath);
  if (!directory || await directory.queryPermission({ mode: 'readwrite' }) !== 'granted') throw new LocalDirectoryAuthorizationRequired();
  let file;
  let source;
  try {
    file = await directory.getFileHandle(info.currentFilename);
    source = await file.getFile();
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') throw new LocalDirectoryAuthorizationRequired();
    throw new Error('所选文件夹中找不到原文件，文件可能已在其他位置移动或改名。');
  }
  if (info.size !== null && source.size !== info.size) throw new Error('此文件与下载记录的大小不同，已停止改名，请确认原文件。');
  if (job.localFileLastModified != null && source.lastModified !== job.localFileLastModified) throw new Error('文件在上次操作后已被修改，已停止改名，请确认原文件。');
  const name = sanitizeFilename(title);
  if (name !== info.currentFilename) {
    let existing;
    try { existing = await directory.getFileHandle(name); }
    catch (error) { if (error?.name !== 'NotFoundError') throw new Error('无法检查新文件名，请确认文件夹可用且有读写权限。'); }
    if (existing && !(await existing.isSameEntry(file))) throw new Error('此文件夹已存在同名文件，请换一个名称。');
    if (typeof file.move !== 'function') throw new Error('此版本浏览器不支持本地文件原地改名，请更新 Chrome。');
    try { await file.move(name); }
    catch (error) {
      if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') throw new LocalDirectoryAuthorizationRequired();
      if (error?.name === 'NotSupportedError') throw new Error('此浏览器不支持本地文件原地改名，请更新 Chrome。');
      throw new Error('本地文件改名失败，请确认文件未被占用，且文件夹允许修改。');
    }
  }
  // The native move can change mtime. A fresh snapshot permits the next rename
  // while rejecting externally replaced or modified files on subsequent attempts.
  const moved = await file.getFile().catch(() => null);
  return { path: `${info.directoryPath}${info.directoryPath.endsWith(info.separator) ? '' : info.separator}${name}`, name, size: source.size, lastModified: moved?.lastModified ?? null };
}
