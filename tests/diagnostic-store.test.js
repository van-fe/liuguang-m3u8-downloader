import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDiagnosticStore, boundDiagnosticReport, DIAGNOSTIC_STORAGE_KEY,
  MAX_DIAGNOSTIC_BYTES, MAX_DIAGNOSTIC_REPORTS
} from '../extension/lib/diagnostic-store.js';

function storage() {
  const values = {};
  return {
    values,
    async get(key) { return structuredClone({ [key]: values[key] }); },
    async set(data) { Object.assign(values, structuredClone(data)); }
  };
}
const size = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;

test('diagnostic store preserves normal reports and upserts the most recent ten atomically', async () => {
  const area = storage();
  const store = createDiagnosticStore(area);
  await Promise.all(Array.from({ length: 15 }, (_, index) => store.upsert(`job-${index}`, {
    schemaVersion: 1, status: 'error', events: [{ stage: 'converting', error: `failure-${index}` }]
  })));
  const reports = await store.list();
  assert.equal(reports.length, MAX_DIAGNOSTIC_REPORTS);
  assert.deepEqual(reports.map(report => report.jobId), Array.from({ length: 10 }, (_, index) => `job-${14 - index}`));
  await store.upsert('job-9', { schemaVersion: 1, status: 'error', events: [{ stage: 'failed' }] });
  assert.equal((await store.list())[0].jobId, 'job-9');
  assert.equal((await store.list()).filter(report => report.jobId === 'job-9').length, 1);
  assert.equal(await store.get('unknown'), null);
});

test('large Unicode diagnostics retain recent events within each report and total byte budgets', async () => {
  const area = storage();
  const store = createDiagnosticStore(area);
  const events = Array.from({ length: 400 }, (_, index) => ({ index, message: `最近事件-${index}：${'中'.repeat(1500)}` }));
  for (let index = 0; index < 10; index++) {
    await store.upsert(`job-${index}`, { schemaVersion: 1, status: 'error', events, ffmpeg: { exitCode: 1 } });
  }
  const reports = await store.list();
  assert.ok(reports.every(report => size(report) <= MAX_DIAGNOSTIC_BYTES));
  assert.ok(size(area.values) < 1024 ** 2);
  assert.ok(reports.every(report => report.diagnosticTruncated));
  assert.equal(reports[0].events.at(-1).index, 399);
});

test('diagnostic reads return isolated copies and clear persists an empty report list', async () => {
  const area = storage();
  const store = createDiagnosticStore(area);
  const original = { schemaVersion: 1, status: 'error', ffmpeg: { logs: ['useful error'] } };
  await store.upsert('job-one', original);
  original.ffmpeg.logs[0] = 'mutated caller';
  const report = await store.get('job-one');
  report.ffmpeg.logs.push('mutated result');
  assert.deepEqual((await store.get('job-one')).ffmpeg.logs, ['useful error']);
  await store.clear();
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(area.values[DIAGNOSTIC_STORAGE_KEY], []);
});

test('invalid report updates fail without poisoning later store operations', async () => {
  const store = createDiagnosticStore(storage());
  await assert.rejects(store.upsert('', {}), /任务编号/);
  await assert.rejects(store.upsert('https://video.example/private', {}), /任务编号/);
  await assert.rejects(store.upsert('job-array', []), /格式/);
  const circular = {}; circular.self = circular;
  await assert.rejects(store.upsert('job-cycle', circular), /序列化/);
  await store.upsert('job-valid', { jobId: 'wrong-id', status: 'error' });
  assert.equal((await store.get('job-valid')).jobId, 'job-valid');
  assert.throws(() => boundDiagnosticReport('job', null), /格式/);
});

test('storage boundary strips video addresses, source fields, filenames, titles, and secrets recursively', async () => {
  const area = storage();
  const store = createDiagnosticStore(area);
  await store.upsert('job-private', {
    schemaVersion: 1, status: 'error', title: 'Private title',
    url: 'https://secret.example/video.m3u8?token=credential',
    source: { format: 'hls', platform: 'web', host: 'secret.example', protocol: 'https:', extension: '.m3u8' },
    events: [{ requestHeaders: { Authorization: 'Bearer credential' }, filename: 'private-title.mp4',
      detail: 'failed https://secret.example/video.m3u8?token=credential and blob:https://secret.example/id' }],
    ffmpeg: { logs: [{ message: 'GET //secret.example/private/video.ts failed' }] }
  });
  const report = await store.get('job-private');
  assert.deepEqual(report.source, { format: 'hls', platform: 'web' });
  const saved = JSON.stringify(area.values);
  for (const forbidden of ['secret.example', 'credential', 'Private title', 'private-title.mp4', 'https:', 'blob:']) assert.ok(!saved.includes(forbidden), forbidden);
  assert.match(saved, /地址已隐藏/);
});

test('terminal marks do not create reports and later stale updates cannot overwrite completion', async () => {
  const store = createDiagnosticStore(storage());
  assert.equal(await store.mark('missing-job', { status: 'cancelled' }), null);
  assert.deepEqual(await store.list(), []);
  await store.upsert('job-save', { schemaVersion: 1, status: 'saving', events: [{ event: 'saving' }] });
  await store.mark('job-save', { status: 'complete', completedAt: 123 });
  await store.upsert('job-save', { schemaVersion: 1, status: 'saving', events: [{ event: 'late progress' }] });
  const report = await store.get('job-save');
  assert.equal(report.status, 'complete');
  assert.equal(report.completedAt, 123);
});
