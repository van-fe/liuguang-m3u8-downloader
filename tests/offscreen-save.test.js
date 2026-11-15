import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { sanitizeFilename } from '../extension/lib/hls.js';

const source = (await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8')).replace(/^import[^\r\n]*$/gm, '');
const extensionId = 'abcdefghijklmnopabcdefghijklmnop';
const blob = `blob:chrome-extension://${extensionId}/local-test-file`;

function harness({ clickError } = {}) {
  let listener;
  const actions = [];
  const context = vm.createContext({
    chrome: { runtime: { id: extensionId, onMessage: { addListener(callback) { listener = callback; } } } },
    cleanupAbandonedDownloads: async () => {}, sanitizeFilename,
    document: {
      createElement(tag) {
        assert.equal(tag, 'a');
        return {
          click() {
            actions.push({ type: 'click', filename: this.download, ownBlob: this.href === blob, hidden: this.hidden });
            if (clickError) throw clickError;
          },
          remove() { actions.push({ type: 'remove' }); },
        };
      },
      body: { append() { actions.push({ type: 'append' }); } },
    },
  });
  vm.runInContext(source, context, { filename: 'offscreen.js' });
  vm.runInContext(`blobs.set('job-1', { url: ${JSON.stringify(blob)}, disk: {} })`, context);
  const request = (data = {}, sender = { id: extensionId }) => {
    let response;
    listener({ target: 'offscreen', type: 'SAVE_WITH_ANCHOR', jobId: 'job-1', url: blob, filename: '中文视频标题', ...data }, sender, value => { response = JSON.parse(JSON.stringify(value)); });
    return response;
  };
  return { actions, request, hasBlob: () => vm.runInContext("blobs.has('job-1')", context) };
}

test('offscreen native save uses the expected MP4 name and retains the disk-backed Blob until browser completion', () => {
  const h = harness();
  assert.deepEqual(h.request(), { ok: true });
  assert.deepEqual(h.actions, [
    { type: 'append' },
    { type: 'click', filename: '中文视频标题.mp4', ownBlob: true, hidden: true },
    { type: 'remove' },
  ]);
  assert.equal(h.hasBlob(), true);
});

test('offscreen save refuses missing or mismatched registered media', () => {
  const h = harness();
  assert.equal(h.request({ jobId: 'missing' }).ok, false);
  assert.equal(h.request({ url: `blob:chrome-extension://${extensionId}/another-file` }).ok, false);
  assert.deepEqual(h.actions, []);
  assert.equal(h.hasBlob(), true);
});

test('web content and other extensions cannot trigger the offscreen native save', () => {
  const h = harness();
  assert.equal(h.request({}, { id: extensionId, tab: { id: 1 } }), undefined);
  assert.equal(h.request({}, { id: 'other-extension' }), undefined);
  assert.deepEqual(h.actions, []);
});

test('a failed native click removes its element and reports the failure for background cleanup', () => {
  const h = harness({ clickError: new Error('Save blocked') });
  assert.deepEqual(h.request(), { ok: false, error: 'Save blocked' });
  assert.equal(h.actions.at(-1).type, 'remove');
  assert.equal(h.hasBlob(), true);
});
