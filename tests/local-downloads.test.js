import test from 'node:test';
import assert from 'node:assert/strict';
import { getLocalDownloadInfo, renameLocalDownload, restoreLocalDownloadPermission, LocalDirectoryAuthorizationRequired } from '../extension/lib/local-downloads.js';

const recorded = { id: 'job-1', status: 'complete', title: 'UI title', downloadId: 72 };
const actualPath = 'C:\\Downloads\\actual name (1).mp4';
const downloads = { async search() { return [{ id: 72, state: 'complete', exists: true, filename: actualPath, fileSize: 1234 }]; } };

function fixture({ size = 1234, permission = 'granted', moveError, snapshotError = false } = {}) {
  const files = new Map();
  const moves = [];
  const source = {
    name: 'actual name (1).mp4', lastModified: 100,
    async getFile() { if (snapshotError && moves.length) throw new Error('Snapshot unavailable after successful move'); return { size, lastModified: this.lastModified }; },
    async isSameEntry(other) { return this === other; },
    async move(name) { if (moveError) throw moveError; moves.push(name); files.delete(this.name); this.name = name; this.lastModified += 1; files.set(name, this); }
  };
  files.set(source.name, source);
  const directory = {
    kind: 'directory', name: 'Downloads',
    async queryPermission() { return permission; },
    async getFileHandle(name) { if (!files.has(name)) throw new DOMException('Missing', 'NotFoundError'); return files.get(name); }
  };
  return { source, directory, files, moves, options: { downloads, getDirectory: async () => directory } };
}

test('local rename uses Chrome actual filename, suffix and size rather than the task display title', async () => {
  const info = await getLocalDownloadInfo(recorded, { downloads });
  assert.equal(info.currentFilename, 'actual name (1).mp4');
  assert.equal(info.currentPath, actualPath);
  assert.equal(info.directoryPath, 'C:\\Downloads');
  assert.equal(info.directoryName, 'Downloads');
  assert.equal(info.size, 1234);
  const f = fixture();
  const result = await renameLocalDownload(recorded, '中文:新名.mp4', f.options);
  assert.deepEqual(f.moves, ['中文_新名.mp4']);
  assert.equal(result.path, 'C:\\Downloads\\中文_新名.mp4');
  assert.equal(result.size, 1234);
  assert.equal(f.files.has('actual name (1).mp4'), false);
  assert.equal(f.files.has('中文_新名.mp4'), true);
});

test('a second rename uses the stored current path even when Chrome history now marks the old path missing', async () => {
  const f = fixture();
  const first = await renameLocalDownload(recorded, 'first', f.options);
  const job = { ...recorded, localFilePath: first.path, localFileSize: first.size, localFileLastModified: first.lastModified };
  const second = await renameLocalDownload(job, 'second', { ...f.options, downloads: { search() { throw new Error('Old download history must not be consulted'); } } });
  assert.equal(second.path, 'C:\\Downloads\\second.mp4');
  assert.deepEqual(f.moves, ['first.mp4', 'second.mp4']);
});

test('a multi-GiB file is renamed only by move without reading or writing its contents', async () => {
  const size = 5 * 1024 ** 3 + 29;
  const f = fixture({ size });
  const result = await renameLocalDownload({ ...recorded, localFilePath: actualPath, localFileSize: size }, 'large', f.options);
  assert.equal(result.size, size);
  assert.deepEqual(f.moves, ['large.mp4']);
});

test('missing or revoked directory permission requires user authorization and never requests it in background', async () => {
  for (const permission of ['prompt', 'denied']) {
    const f = fixture({ permission });
    await assert.rejects(renameLocalDownload(recorded, 'new', f.options), LocalDirectoryAuthorizationRequired);
    assert.deepEqual(f.moves, []);
  }
  await assert.rejects(renameLocalDownload(recorded, 'new', { downloads, getDirectory: async () => null }), LocalDirectoryAuthorizationRequired);
});

test('an expired saved directory permission is restored in a user gesture before the background rename', async () => {
  const f = fixture();
  let permission = 'prompt';
  const requests = [];
  f.directory.queryPermission = async options => { assert.deepEqual(options, { mode: 'readwrite' }); return permission; };
  f.directory.requestPermission = async options => { requests.push(options); permission = 'granted'; return permission; };
  const restored = await restoreLocalDownloadPermission(recorded, { ...f.options, userActivation: true });
  assert.deepEqual(restored, { available: true, granted: true, permission: 'granted' });
  assert.deepEqual(requests, [{ mode: 'readwrite' }]);
  assert.deepEqual(f.moves, [], 'restoring access must never rename or read the file contents');
  const renamed = await renameLocalDownload(recorded, 'restored', f.options);
  assert.equal(renamed.path, 'C:\\Downloads\\restored.mp4');
  assert.deepEqual(f.moves, ['restored.mp4']);
});

test('granted permission and an absent saved directory never issue permission requests', async () => {
  const f = fixture();
  f.directory.requestPermission = async () => { throw new Error('Unexpected permission request'); };
  assert.deepEqual(await restoreLocalDownloadPermission(recorded, { ...f.options, userActivation: true }), {
    available: true, granted: true, permission: 'granted'
  });
  assert.deepEqual(await restoreLocalDownloadPermission(recorded, { downloads, getDirectory: async () => null, userActivation: true }), {
    available: false, granted: false
  });
  assert.deepEqual(f.moves, []);
});

test('permission restoration requires a current user gesture and respects an explicitly denied grant', async () => {
  for (const permission of ['prompt', 'denied']) {
    const f = fixture({ permission });
    f.directory.requestPermission = async () => { throw new Error('Unexpected permission request'); };
    const result = await restoreLocalDownloadPermission(recorded, { ...f.options, userActivation: false });
    assert.equal(result.available, true);
    assert.equal(result.granted, false);
    assert.equal(result.permission, permission);
    assert.equal(result.requiresUserActivation, permission === 'prompt' ? true : undefined);
    if (permission === 'denied') {
      assert.deepEqual(await restoreLocalDownloadPermission(recorded, { ...f.options, userActivation: true }), {
        available: true, granted: false, permission: 'denied'
      });
    }
    assert.deepEqual(f.moves, []);
  }
  const f = fixture({ permission: 'prompt' });
  let active = true;
  f.options.getDirectory = async () => { active = false; return f.directory; };
  f.directory.requestPermission = async () => { throw new Error('Activation expired while reading the saved directory'); };
  const expired = await restoreLocalDownloadPermission(recorded, { ...f.options, userActivation: () => active });
  assert.equal(expired.requiresUserActivation, true);
});

test('a declined or failed permission restoration never reports access or touches the local video', async () => {
  for (const response of ['denied', 'prompt']) {
    const f = fixture({ permission: 'prompt' });
    f.directory.requestPermission = async () => response;
    assert.deepEqual(await restoreLocalDownloadPermission(recorded, { ...f.options, userActivation: true }), {
      available: true, granted: false, permission: response
    });
    assert.deepEqual(f.moves, []);
    assert.equal(f.files.has('actual name (1).mp4'), true);
  }
  const f = fixture({ permission: 'prompt' });
  f.directory.requestPermission = async () => { throw new DOMException('Private C:\\Downloads\\video.mp4', 'AbortError'); };
  await assert.rejects(restoreLocalDownloadPermission(recorded, { ...f.options, userActivation: true }), error => {
    assert.match(error.message, /恢复文件夹权限/);
    assert.doesNotMatch(error.message, /Private|Downloads|video\.mp4/);
    return true;
  });
  assert.deepEqual(f.moves, []);
});

test('existing destination, missing source, changed size and changed mtime all preserve the original file', async () => {
  const collision = fixture();
  collision.files.set('new.mp4', { async isSameEntry() { return false; } });
  await assert.rejects(renameLocalDownload(recorded, 'new', collision.options), /同名/);
  assert.deepEqual(collision.moves, []);
  const missing = fixture(); missing.files.clear();
  await assert.rejects(renameLocalDownload(recorded, 'new', missing.options), /找不到原文件/);
  const wrongSize = fixture({ size: 999 });
  await assert.rejects(renameLocalDownload(recorded, 'new', wrongSize.options), /大小不同/);
  assert.deepEqual(wrongSize.moves, []);
  const modified = fixture();
  await assert.rejects(renameLocalDownload({ ...recorded, localFilePath: actualPath, localFileSize: 1234, localFileLastModified: 1 }, 'new', modified.options), /已被修改/);
  assert.deepEqual(modified.moves, []);
});

test('unsupported or failed native moves never fall back to copying or deleting files', async () => {
  const unsupported = fixture(); delete unsupported.source.move;
  await assert.rejects(renameLocalDownload(recorded, 'new', unsupported.options), /不支持.*原地改名/);
  const failed = fixture({ moveError: new DOMException('Busy', 'InvalidStateError') });
  await assert.rejects(renameLocalDownload(recorded, 'new', failed.options), /改名失败/);
  assert.equal(failed.files.has('actual name (1).mp4'), true);
  const revoked = fixture({ moveError: new DOMException('No write access', 'NotAllowedError') });
  await assert.rejects(renameLocalDownload(recorded, 'new', revoked.options), LocalDirectoryAuthorizationRequired);
});

test('a successful native rename remains successful if obtaining its new metadata snapshot fails', async () => {
  const f = fixture({ snapshotError: true });
  const result = await renameLocalDownload(recorded, 'new', f.options);
  assert.equal(result.path, 'C:\\Downloads\\new.mp4');
  assert.equal(result.size, 1234);
  assert.equal(result.lastModified, null);
  assert.deepEqual(f.moves, ['new.mp4']);
});

test('local info rejects incomplete, missing, and malformed absolute paths without inventing a file name', async () => {
  await assert.rejects(getLocalDownloadInfo({ ...recorded, status: 'saving' }, { downloads }), /下载完成/);
  await assert.rejects(getLocalDownloadInfo(recorded, { downloads: { async search() { return []; } } }), /不存在/);
  for (const filename of ['relative.mp4', 'C:\\Downloads\\', '/tmp/..']) {
    await assert.rejects(getLocalDownloadInfo(recorded, { downloads: { async search() { return [{ state: 'complete', filename }]; } } }), /无法确定/);
  }
  const unix = await getLocalDownloadInfo({ ...recorded, localFilePath: '/tmp/video.mp4', localFileSize: 1 }, { downloads });
  assert.equal(unix.directoryPath, '/tmp');
  assert.equal(unix.currentFilename, 'video.mp4');
});
