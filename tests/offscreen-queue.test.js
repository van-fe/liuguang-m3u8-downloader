import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate } from 'node:timers/promises';
import { sanitizeFilename } from '../extension/lib/hls.js';
import { createJobDiagnostic, describeMergeFailure, summarizeTracks } from '../extension/lib/diagnostics.js';

const source = (await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8')).replace(/^import[^\r\n]*$/gm, '');
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

function harness({ removeErrorFor, saveGateFor, saveErrorFor, cleanupGate, clock } = {}) {
  let listener;
  let blobSequence = 0;
  const messages = [];
  const warnings = [];
  const transfers = new Map();
  const engines = [];
  const disks = new Map();
  const saves = new Map();
  const starts = [];
  const output = new Uint8Array(64);
  output.set(new TextEncoder().encode('ftyp'), 4);

  async function transfer(id, options, result) {
    const sink = await options.createSink('input.ts');
    assert.equal(sink.jobId, id, 'each transfer must use its own disk');
    options.signal.throwIfAborted();
    starts.push(id);
    return new Promise((resolve, reject) => {
      const abort = () => reject(options.signal.reason);
      options.signal.addEventListener('abort', abort, { once: true });
      const finish = (callback, value) => {
        options.signal.removeEventListener('abort', abort);
        callback(value);
      };
      transfers.set(id, {
        signal: options.signal,
        complete: () => finish(resolve, result),
        fail: error => finish(reject, error),
      });
    });
  }

  class FFmpeg {
    constructor() { this.events = {}; this.terminated = false; engines.push(this); }
    on(name, callback) { this.events[name] = callback; }
    async load() {}
    async createDir() {}
    async mount(type, options) {
      if (type === 'OPFS') this.jobId = options.fileHandle.jobId;
      if (type === 'WORKERFS') this.inputJobId = options.files[0].jobId;
    }
    async unmount() {}
    exec() {
      return new Promise((resolve, reject) => {
        this.complete = () => resolve(0);
        this.fail = reject;
      });
    }
    terminate() {
      this.terminated = true;
      this.fail?.(new Error('engine terminated'));
    }
  }

  const context = vm.createContext({
    FFmpeg, AbortController, DOMException, TextDecoder,
    ...(clock ? { Date: { now: clock.now } } : {}),
    URL: {
      createObjectURL: () => `blob:chrome-extension://${extensionId}/${++blobSequence}`,
      revokeObjectURL() {},
    },
    setInterval: () => 1, clearInterval() {},
    setTimeout: clock?.setTimeout || setTimeout, clearTimeout: clock?.clearTimeout || clearTimeout,
    console: { warn: (...args) => warnings.push(args) },
    chrome: { runtime: {
      id: extensionId,
      getURL: name => `chrome-extension://${extensionId}/${name}`,
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) {
        messages.push({ ...structuredClone(message), observedAt: clock?.now() ?? Date.now() });
        if (message.type === 'SAVE_BLOB' && message.jobId === saveErrorFor) return { ok: false, error: 'browser save failed' };
        if (message.type === 'SAVE_BLOB' && message.jobId === saveGateFor) {
          return new Promise(resolve => { saves.set(message.jobId, () => resolve({ ok: true })); });
        }
        return { ok: true };
      },
    } },
    cleanupAbandonedDownloads: () => cleanupGate || Promise.resolve(),
    async createDownloadDisk(jobId) {
      const disk = {
        jobId, removed: false, cleared: false,
        output: { jobId, async getFile() { return new Blob([output], { type: 'video/mp4' }); } },
        async createOutputSink() { return { jobId }; },
        async createSink() { return { jobId }; },
        async writeFile() {},
        async files() { return [{ name: 'input.ts', jobId, size: 64 }]; },
        async clearInputs() { this.cleared = true; },
        async remove() {
          this.removed = true;
          if (jobId === removeErrorFor) throw new Error('cleanup failed');
        },
      };
      disks.set(jobId, disk);
      return disk;
    },
    explainDiskError: error => error.message,
    requestToSink: (url, options) => transfer(new URL(url).pathname.slice(1), options, { bytes: 64 }),
    resolveTracks: async url => ({ jobId: new URL(url).pathname.slice(1), video: { segments: [{ url: 'input.ts' }] } }),
    downloadTracks: (tracks, options) => transfer(tracks.jobId, options, { inputs: ['input.ts'], bytes: 64, completedSegments: 1 }),
    buildFFmpegArgs: inputs => [...inputs],
    createJobDiagnostic, describeMergeFailure, summarizeTracks, sanitizeFilename,
  });
  vm.runInContext(source, context, { filename: 'offscreen.js' });
  const request = (type, data = {}, sender = { id: extensionId }) => {
    let response;
    listener({ target: 'offscreen', type, ...data }, sender, value => { response = structuredClone(value); });
    return response;
  };
  const start = (id, taskConcurrency, format = 'mp4', saveAs = true) => request('RUN_JOB', {
    job: { id, url: `https://cdn.example/${id}`, title: id, format, saveAs },
    settings: { ...(taskConcurrency === undefined ? {} : { taskConcurrency }), concurrency: 4, retries: 0 },
  });
  const statuses = id => messages.filter(message => message.type === 'JOB_UPDATE' && message.jobId === id).map(message => message.patch.status);
  const saved = () => messages.filter(message => message.type === 'SAVE_BLOB').map(message => message.jobId);
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (predicate()) return;
      await setImmediate();
    }
    assert.fail(`Offscreen state did not settle. Started: ${starts.join(', ')}; saved: ${saved().join(', ')}`);
  };
  return { request, start, starts, transfers, engines, disks, messages, warnings, statuses, saved, saves, waitFor };
}

function fakeClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) { const id = ++sequence; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout(id) { timers.delete(id); },
    pending: () => timers.size,
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
  };
}

test('one hundred actual transfers start concurrently before any task completes', async () => {
  const clock = fakeClock();
  const h = harness({ clock });
  const ids = Array.from({ length: 100 }, (_, index) => `job-${index}`);
  for (const id of ids) assert.equal(h.start(id, undefined, 'mp4', false).ok, true);
  await h.waitFor(() => h.starts.length === ids.length);
  assert.deepEqual(h.starts, ids);
  assert.deepEqual(h.saved(), []);
  for (const item of h.transfers.values()) {
    assert.equal(item.signal.aborted, false);
    item.complete();
  }
  await h.waitFor(() => h.saved().length === 1 && clock.pending() === 1);
  for (let index = 1; index < ids.length; index++) {
    clock.advance(150);
    await h.waitFor(() => h.saved().length === index + 1 && (index === ids.length - 1 || clock.pending() === 1));
  }
  await h.waitFor(() => h.saved().length === ids.length);
  assert.deepEqual(h.starts, ids);
  assert.deepEqual(new Set(h.saved()), new Set(ids));
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(h.messages.filter(message => message.type === 'SAVE_BLOB').map(message => message.observedAt), ids.map((_, index) => index * 150));
});

test('cancelling selected running jobs does not abort or block the other simultaneous transfers', async () => {
  const h = harness();
  for (const id of ['a', 'b', 'c', 'd', 'e']) h.start(id, 2);
  await h.waitFor(() => h.starts.length === 5);
  h.request('CANCEL_JOB', { jobId: 'd' });
  h.request('CANCEL_JOB', { jobId: 'b' });
  await h.waitFor(() => h.statuses('b').at(-1) === 'cancelled' && h.statuses('d').at(-1) === 'cancelled');
  assert.equal(h.transfers.get('a').signal.aborted, false);
  assert.equal(h.transfers.get('b').signal.aborted, true);
  assert.equal(h.transfers.get('d').signal.aborted, true);
  assert.equal(h.statuses('b').at(-1), 'cancelled');
  for (const id of ['a', 'c', 'e']) assert.equal(h.transfers.get(id).signal.aborted, false);
  h.transfers.get('a').complete();
  h.transfers.get('c').complete();
  h.transfers.get('e').complete();
  await h.waitFor(() => h.saved().length === 3);
  assert.deepEqual(new Set(h.saved()), new Set(['a', 'c', 'e']));
  assert.equal(h.disks.get('b').removed, true);
});

test('a failed job reports its own error while simultaneous and newly added transfers continue', async () => {
  const h = harness();
  for (const id of ['a', 'b', 'c']) h.start(id, 2);
  await h.waitFor(() => h.starts.length === 3);
  h.transfers.get('a').fail(new Error('network failed for a'));
  await h.waitFor(() => h.statuses('a').at(-1) === 'error');
  assert.equal(h.statuses('a').at(-1), 'error');
  assert.equal(h.transfers.get('b').signal.aborted, false);
  assert.equal(h.statuses('b').at(-1), 'downloading');
  const failure = h.messages.find(message => message.type === 'JOB_UPDATE' && message.jobId === 'a' && message.patch.status === 'error');
  assert.equal(failure.patch.error, 'network failed for a');
  h.start('d', 1);
  await h.waitFor(() => h.starts.includes('d'));
  h.transfers.get('b').complete();
  h.transfers.get('c').complete();
  h.transfers.get('d').complete();
  await h.waitFor(() => h.saved().length === 3);
});

test('historical numeric settings and messages cannot impose a simultaneous task limit', async () => {
  const h = harness();
  const oldValues = [1, 3, 8, 99];
  for (let index = 0; index < 100; index++) {
    assert.equal(h.request('SET_TASK_CONCURRENCY', { taskConcurrency: oldValues[index % oldValues.length] }).ok, true);
    assert.equal(h.start(`job-${index}`, oldValues[index % oldValues.length]).ok, true);
  }
  await h.waitFor(() => h.starts.length === 100);
  assert.equal(h.saved().length, 0);
  for (const item of h.transfers.values()) item.complete();
  await h.waitFor(() => h.saved().length === 100);
});

test('duplicate dispatches do not rerun active or browser-owned saved jobs', async () => {
  const h = harness();
  for (const id of ['a', 'b', 'a', 'b']) h.start(id, 1);
  await h.waitFor(() => h.starts.length === 2);
  h.transfers.get('a').complete();
  await h.waitFor(() => h.saved().includes('a'));
  h.start('a', 1);
  h.start('b', 1);
  h.transfers.get('b').complete();
  await h.waitFor(() => h.saved().length === 2);
  await setImmediate();
  assert.deepEqual(h.starts, ['a', 'b']);
  assert.deepEqual(h.saved(), ['a', 'b']);
});

test('cleanup failure cannot block concurrent or subsequently added tasks', async () => {
  const h = harness({ removeErrorFor: 'a' });
  h.start('a', 1);
  h.start('b', 1);
  await h.waitFor(() => h.starts.length === 2);
  h.transfers.get('a').fail(new Error('download failed'));
  await h.waitFor(() => h.warnings.length === 1);
  assert.equal(h.disks.get('a').removed, true);
  h.start('c', 1);
  await h.waitFor(() => h.starts.includes('c'));
  h.transfers.get('b').complete();
  h.transfers.get('c').complete();
  await h.waitFor(() => h.saved().length === 2);
  assert.equal(h.warnings.length, 1);
});

test('simultaneous HLS merges have separate engines, files, and cancellation state', async () => {
  const h = harness();
  h.start('a', 2, 'hls');
  h.start('b', 2, 'hls');
  await h.waitFor(() => h.starts.length === 2);
  h.transfers.get('a').complete();
  h.transfers.get('b').complete();
  await h.waitFor(() => h.engines.every(engine => engine.complete));
  assert.equal(h.engines.length, 2);
  for (const engine of h.engines) assert.equal(engine.jobId, engine.inputJobId);
  const a = h.engines.find(engine => engine.jobId === 'a');
  const b = h.engines.find(engine => engine.jobId === 'b');
  h.request('CANCEL_JOB', { jobId: 'a' });
  assert.equal(a.terminated, true);
  assert.equal(b.terminated, false);
  b.complete();
  await h.waitFor(() => h.saved().includes('b') && h.statuses('a').at(-1) === 'cancelled');
  assert.deepEqual(h.saved(), ['b']);
  assert.equal(h.disks.get('a').removed, true);
});

test('cancelling during a pending browser save is isolated from another running job', async () => {
  const h = harness({ saveGateFor: 'a' });
  h.start('a', 2);
  h.start('b', 2);
  h.start('c', 2);
  await h.waitFor(() => h.starts.length === 3);
  h.transfers.get('a').complete();
  await h.waitFor(() => h.saves.has('a'));
  h.request('CANCEL_JOB', { jobId: 'a' });
  h.request('RELEASE_BLOB', { jobId: 'a' });
  h.saves.get('a')();
  await h.waitFor(() => h.starts.includes('c'));
  assert.equal(h.transfers.get('b').signal.aborted, false);
  assert.equal(h.statuses('b').at(-1), 'downloading');
  assert.equal(h.disks.get('a').removed, true);
  h.transfers.get('b').complete();
  h.transfers.get('c').complete();
  await h.waitFor(() => h.saved().length === 3);
});

test('all concurrent jobs wait for abandoned-cache cleanup before creating their own disk', async () => {
  let finishCleanup;
  const h = harness({ cleanupGate: new Promise(resolve => { finishCleanup = resolve; }) });
  for (const id of ['a', 'b', 'c']) h.start(id);
  await setImmediate();
  assert.equal(h.disks.size, 0);
  finishCleanup();
  await h.waitFor(() => h.starts.length === 3);
  for (const item of h.transfers.values()) item.complete();
  await h.waitFor(() => h.saved().length === 3);
});

test('untrusted senders cannot dispatch downloads or cancel another job', async () => {
  const h = harness();
  h.start('a', 1);
  await h.waitFor(() => h.starts.length === 1);
  for (const sender of [{ id: 'other-extension' }, { id: extensionId, tab: { id: 4 } }]) {
    assert.equal(h.request('RUN_JOB', { job: { id: 'forged', url: 'https://cdn.example/forged', format: 'mp4' } }, sender), undefined);
    assert.equal(h.request('CANCEL_JOB', { jobId: 'a' }, sender), undefined);
    assert.equal(h.request('SET_TASK_CONCURRENCY', { taskConcurrency: 1 }, sender), undefined);
  }
  await setImmediate();
  assert.deepEqual(h.starts, ['a']);
  assert.equal(h.transfers.get('a').signal.aborted, false);
  h.transfers.get('a').complete();
  await h.waitFor(() => h.saved().length === 1);
});

test('automatic save pacing starts after the previous handshake settles and manual saves bypass it', async () => {
  const clock = fakeClock();
  const h = harness({ clock, saveGateFor: 'a' });
  h.start('a', undefined, 'mp4', false);
  h.start('b', undefined, 'mp4', false);
  h.start('manual');
  await h.waitFor(() => h.starts.length === 3);
  h.transfers.get('a').complete();
  await h.waitFor(() => h.saves.has('a'));
  h.transfers.get('b').complete();
  h.transfers.get('manual').complete();
  await h.waitFor(() => h.saved().includes('manual'));
  assert.deepEqual(h.saved(), ['a', 'manual']);
  clock.advance(1000);
  await setImmediate();
  assert.equal(h.saved().includes('b'), false);
  h.saves.get('a')();
  await h.waitFor(() => clock.pending() === 1);
  clock.advance(149);
  await setImmediate();
  assert.equal(h.saved().includes('b'), false);
  clock.advance(1);
  await h.waitFor(() => h.saved().includes('b'));
  const handoffs = h.messages.filter(message => message.type === 'SAVE_BLOB');
  assert.deepEqual(handoffs.map(message => [message.jobId, message.observedAt]), [['a', 0], ['manual', 0], ['b', 1150]]);
});

test('cancelled automatic saves never dispatch while waiting for another handoff or its pacing delay', async () => {
  const clock = fakeClock();
  const h = harness({ clock, saveGateFor: 'a' });
  for (const id of ['a', 'b', 'c']) h.start(id, undefined, 'mp4', false);
  await h.waitFor(() => h.starts.length === 3);
  h.transfers.get('a').complete();
  await h.waitFor(() => h.saves.has('a'));
  h.transfers.get('b').complete();
  h.transfers.get('c').complete();
  await h.waitFor(() => h.statuses('b').at(-1) === 'saving' && h.statuses('c').at(-1) === 'saving');
  h.request('CANCEL_JOB', { jobId: 'b' });
  h.saves.get('a')();
  await h.waitFor(() => h.statuses('b').at(-1) === 'cancelled' && clock.pending() === 1);
  h.request('CANCEL_JOB', { jobId: 'c' });
  await h.waitFor(() => h.statuses('c').at(-1) === 'cancelled');
  assert.deepEqual(h.saved(), ['a']);
  assert.equal(h.disks.get('b').removed, true);
  assert.equal(h.disks.get('c').removed, true);
  h.start('d', undefined, 'mp4', false);
  await h.waitFor(() => h.starts.includes('d'));
  h.transfers.get('d').complete();
  await h.waitFor(() => clock.pending() === 1);
  clock.advance(150);
  await h.waitFor(() => h.saved().includes('d'));
  assert.deepEqual(h.saved(), ['a', 'd']);
});

test('a failed automatic handoff releases the next save after the same pacing interval', async () => {
  const clock = fakeClock();
  const h = harness({ clock, saveErrorFor: 'a' });
  h.start('a', undefined, 'mp4', false);
  h.start('b', undefined, 'mp4', false);
  await h.waitFor(() => h.starts.length === 2);
  h.transfers.get('a').complete();
  h.transfers.get('b').complete();
  await h.waitFor(() => h.statuses('a').at(-1) === 'error' && clock.pending() === 1);
  assert.deepEqual(h.saved(), ['a']);
  assert.equal(h.disks.get('a').removed, true);
  clock.advance(149);
  await setImmediate();
  assert.equal(h.saved().includes('b'), false);
  clock.advance(1);
  await h.waitFor(() => h.saved().includes('b'));
  assert.deepEqual(h.messages.filter(message => message.type === 'SAVE_BLOB').map(message => message.observedAt), [0, 150]);
});
