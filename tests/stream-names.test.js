import test from 'node:test';
import assert from 'node:assert/strict';
import { getStreamTitle } from '../extension/lib/stream-names.js';

test('explicit custom titles override detected metadata and explicit empty titles stay empty', () => {
  assert.equal(getStreamTitle({ title: 'Detected', customTitle: 'Custom' }), 'Custom');
  assert.equal(getStreamTitle({ title: 'Detected', customTitle: '' }), '');
  assert.equal(getStreamTitle({ title: 'Detected', customTitle: '  ' }), '');
  assert.equal(getStreamTitle({ title: 'Detected', customTitle: '视频' }), '视频');
  assert.equal(getStreamTitle({ title: ' Actual title ' }), 'Actual title');
});

test('generic detected placeholders never masquerade as a filename', () => {
  for (const title of ['网页视频', 'X视频', 'X 视频', '视频源', '视频源1', '视频源 23', '视频', '', '   ']) {
    assert.equal(getStreamTitle({ title }), '');
  }
  assert.equal(getStreamTitle({ title: '视频源23剪辑' }), '视频源23剪辑');
  assert.equal(getStreamTitle(undefined), '');
  assert.equal(getStreamTitle({ title: 'Detected', customTitle: undefined }), '');
});
