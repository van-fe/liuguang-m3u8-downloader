import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadNameStore, sanitizeDownloadName, isOwnDownloadBlob, DOWNLOAD_NAMES_STORAGE_KEY, DOWNLOAD_NAME_TTL_MS } from '../extension/lib/download-names.js';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const blob = name => `blob:chrome-extension://${extensionId}/${name}`;
const item = (name, id = 1) => ({ id, url: blob(name) });
function storage(values = {}) {
  return { values,
    async get(key) { return structuredClone({ [key]: values[key] }); },
    async set(data) { Object.assign(values, structuredClone(data)); }
  };
}
const storeFor = (area, now = Date.now) => createDownloadNameStore(area, { extensionId, now });

test('only exact extension Blob origins are eligible', () => {
  assert.equal(isOwnDownloadBlob(blob('one'), extensionId), true);
  for (const value of [undefined, '', 'https://example.test/video.mp4', `blob:https://${extensionId}/one`,
    `blob:chrome-extension://${extensionId}.evil/one`, `blob:chrome-extension://${extensionId}@evil/one`,
    `blob:chrome-extension://evil/${extensionId}/one`, `${blob('one')}?x=1`, `${blob('one')}#x`]) {
    assert.equal(isOwnDownloadBlob(value, extensionId), false);
  }
});

test('anchor registration restores after restart and accepts a missing creator ID but never an external creator', async () => {
  const area = storage();
  await storeFor(area).register(blob('one'), '测试:名称.mp4', 'job-one');
  const restored = storeFor(area);
  const matched = await restored.match(item('one', 29));
  assert.equal(matched.filename, '测试_名称.mp4');
  assert.equal(matched.jobId, 'job-one');
  assert.equal(matched.downloadId, 29);
  assert.equal((await restored.match({ ...item('one', 29), byExtensionId: extensionId })).jobId, 'job-one');
  for (const candidate of [
    { ...item('one', 29), byExtensionId: 'another-extension' },
    { ...item('one', 29), byExtensionId: '' },
    { ...item('one', 29), url: `blob:chrome-extension://${extensionId}.evil/one` },
    item('unregistered'), { url: blob('one') }
  ]) assert.equal(await restored.match(candidate), null);
});

test('an anchor Blob can be claimed by only one download ID, including after restart', async () => {
  const area = storage();
  await storeFor(area).register(blob('one'), 'one.mp4', 'job-one');
  const store = storeFor(area);
  const results = await Promise.all([store.match(item('one', 5)), store.match(item('one', 6))]);
  assert.equal(results[0].downloadId, 5);
  assert.equal(results[1], null);
  assert.equal(await storeFor(area).match(item('one', 6)), null);
  assert.equal((await storeFor(area).match(item('one', 5))).jobId, 'job-one');
});

test('invalid names and missing jobs cannot register an unrelated download', async () => {
  const store = storeFor(storage());
  for (const filename of [undefined, '', '  ', null, 10]) await assert.rejects(store.register(blob('one'), filename, 'job-one'), /文件名/);
  await assert.rejects(store.register(blob('one'), 'one.mp4'), /任务/);
  await assert.rejects(store.register('https://example.test/video.mp4', 'one.mp4', 'job-one'), /本地/);
  assert.equal(sanitizeDownloadName('../CON.mp4'), '__CON.mp4');
  assert.equal(sanitizeDownloadName('NUL.mp4'), '_NUL.mp4');
  for (const extension of ['.mp4', '.MP4', '.json']) {
    const name = sanitizeDownloadName(`${'视频'.repeat(180)}${extension}`);
    assert.ok(name.endsWith(extension));
    assert.equal(Array.from(name).length, 180);
  }
});

test('late-cancellation registrations expire after ten minutes', async () => {
  let now = 100;
  const area = storage();
  await storeFor(area, () => now).register(blob('one'), 'one.mp4', 'job-one');
  now += DOWNLOAD_NAME_TTL_MS - 1;
  assert.ok(await storeFor(area, () => now).match(item('one')));
  now++;
  assert.equal(await storeFor(area, () => now).match(item('one')), null);
  await storeFor(area, () => now).register(blob('two'), 'two.mp4', 'job-two');
  assert.equal(area.values[DOWNLOAD_NAMES_STORAGE_KEY].length, 1);
});

test('all concurrent save registrations survive beyond 64 entries and remain matchable after restart', async () => {
  const area = storage();
  let now = 100;
  const store = storeFor(area, () => now++);
  await Promise.all(Array.from({ length: 100 }, (_, index) => store.register(blob(`entry-${index}`), `${index}.mp4`, `job-${index}`)));
  assert.equal(area.values[DOWNLOAD_NAMES_STORAGE_KEY].length, 100);
  const restarted = storeFor(area, () => now);
  const matched = await Promise.all(Array.from({ length: 100 }, (_, index) => restarted.match(item(`entry-${index}`, 1000 + index))));
  for (const [index, entry] of matched.entries()) {
    assert.equal(entry.filename, `${index}.mp4`);
    assert.equal(entry.jobId, `job-${index}`);
    assert.equal(entry.downloadId, 1000 + index);
  }
  await Promise.all(matched.map(entry => restarted.complete(entry.downloadId)));
  assert.deepEqual(area.values[DOWNLOAD_NAMES_STORAGE_KEY], []);
});

test('terminal cleanup and failed startup remove only their own registration', async () => {
  const area = storage();
  const store = storeFor(area);
  await store.register(blob('one'), 'one.mp4', 'job-one');
  await store.register(blob('two'), 'two.mp4', 'job-two');
  await store.match(item('one', 5));
  await store.complete(99);
  assert.ok(await store.match(item('one', 5)));
  await store.complete(5);
  assert.equal(await store.match(item('one', 5)), null);
  await store.remove(blob('two'));
  assert.equal(await store.match(item('two', 6)), null);
});

test('invalid legacy records cannot claim anchors and failed storage does not poison later operations', async () => {
  const area = storage({ [DOWNLOAD_NAMES_STORAGE_KEY]: [
    { url: blob('legacy'), filename: 'legacy.mp4', createdAt: 100, expiresAt: 1000 },
    { url: blob('no-name'), jobId: 'job-one', phase: 'anchor', createdAt: 100, expiresAt: 1000 }
  ] });
  const store = storeFor(area, () => 200);
  assert.equal(await store.match(item('legacy')), null);
  assert.equal(await store.match(item('no-name')), null);
  await store.register(blob('one'), 'one.mp4', 'job-one');
  const get = area.get;
  area.get = async () => { throw new Error('Storage unavailable'); };
  await assert.rejects(store.match(item('one')), /Storage/);
  area.get = get;
  assert.equal((await store.match(item('one'))).jobId, 'job-one');
});
