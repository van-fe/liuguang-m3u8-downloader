import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobDiagnostic, describeMergeFailure, isRoutineAbort, redactDiagnosticText, sanitizeDiagnosticValue, summarizeTracks } from '../extension/lib/diagnostics.js';

test('diagnostic collection omits page/video addresses, domains, titles and credentials', () => {
  const diagnostic = createJobDiagnostic({ id: 'job-1', url: 'https://private.example/video?token=secret', postUrl: 'https://x.com/user/status/123', title: 'private title' }, {});
  diagnostic.event('failure', {
    url: 'https://private.example/private-path', host: 'private.example', postId: '123', title: 'private title',
    nested: { uri: 'https://secret.example/secret', token: 'secret value', Cookie: 'account=secret' },
    message: 'Unable to open https://user:password@cdn.example/private.m3u8?token=secret or //cdn.example/private.ts',
  });
  diagnostic.log({ message: 'Error loading https://video.example/file.ts?signature=abc' });
  diagnostic.fail(new Error('Cannot read blob:https://video.example/uuid'), 'download');
  const json = JSON.stringify(diagnostic.snapshot());
  for (const forbidden of ['private.example', 'secret.example', 'cdn.example', 'video.example', 'x.com', 'private title', 'password', 'signature=abc', 'secret value', 'account=secret']) assert.ok(!json.includes(forbidden), forbidden);
  assert.ok(json.includes('[地址已隐藏]'));
  assert.equal(sanitizeDiagnosticValue({ message: 'Cookie: private-secret' }).message, '[认证信息已隐藏]');
});

test('merge error preserves the meaningful error preceding routine Aborted()', () => {
  const diagnostic = createJobDiagnostic({ id: 'job-2' }, {});
  diagnostic.log({ message: 'Could not find tag for codec pcm_bluray in stream #1, codec not currently supported in container' });
  diagnostic.log({ message: 'Could not write header: Invalid argument' });
  diagnostic.log({ message: 'Aborted()' });
  assert.equal(diagnostic.report.ffmpeg.ignoredAbortLines, 1);
  assert.equal(diagnostic.report.ffmpeg.logs.length, 2);
  assert.match(describeMergeFailure(1, diagnostic.report.ffmpeg.logs), /pcm_bluray/);
  assert.doesNotMatch(describeMergeFailure(1, diagnostic.report.ffmpeg.logs), /Aborted\(\)/);
  assert.equal(isRoutineAbort('Aborted(native code called abort())'), true);
  assert.equal(isRoutineAbort('Aborted(OOM)'), false);
  assert.match(describeMergeFailure(-1, [{ message: 'Aborted(OOM)' }]), /内存/);
});

test('address redaction preserves internal MP4 paths and browser build numbers', () => {
  assert.equal(redactDiagnosticText('/output/output.mp4'), '/output/output.mp4');
  assert.equal(redactDiagnosticText('/input/t0-s2.ts'), '/input/t0-s2.ts');
  assert.equal(redactDiagnosticText('Chrome/155.0.8059.85'), 'Chrome/155.0.8059.85');
  assert.equal(redactDiagnosticText('192.0.2.1:8080/video.m3u8'), '[地址已隐藏]');
  assert.equal(redactDiagnosticText('private.example/video.m3u8'), '[地址已隐藏]');
});

test('encoded and bare media addresses are removed, including unknown fields and FFmpeg metadata', () => {
  const diagnostic = createJobDiagnostic({ id: 'private-metadata' }, {});
  const examples = [
    'https%3A%2F%2Fprivate.example%2Fsecret%2Fvideo.m3u8',
    'https%253A%252F%252Fprivate.example%252Fsecret',
    'https&#58;&#47;&#47;private.example/secret',
    'private.example/secret/video.m3u8',
    '192.0.2.1:8080/secret/video.m3u8',
  ];
  for (const example of examples) diagnostic.event('unexpected-error', { message: `Unable to read ${example}` });
  diagnostic.log({ message: '  Metadata:' });
  diagnostic.log({ message: '    comment         : https%3A%2F%2Fprivate.example%2Fsecret' });
  diagnostic.log({ message: '    custom_label    : private video title' });
  diagnostic.log({ message: '  Duration: 00:00:01.00, bitrate: 100 kb/s' });
  diagnostic.log({ message: '  Stream #0:0: Video: h264, 320x180' });
  diagnostic.log({ message: "Error loading '/input/t0-s2.ts'" });
  const json = JSON.stringify(diagnostic.snapshot());
  for (const forbidden of ['private.example', '192.0.2.1', 'private video title', '%2Fsecret']) assert.ok(!json.includes(forbidden), forbidden);
  assert.ok(json.includes('h264'));
  assert.ok(json.includes('t0-s2.ts'));
  assert.equal(diagnostic.report.ffmpeg.ignoredMetadataLines, 3);
});

test('verbose logs retain the beginning and tail with bounded persistent size', () => {
  const diagnostic = createJobDiagnostic({ id: 'bounded' }, {});
  diagnostic.log({ message: 'input-header' });
  for (let index = 0; index < 2000; index++) {
    diagnostic.log({ message: `${index}: ${'错'.repeat(600)}` });
    diagnostic.event('resource-response', { file: `t0-s${index}.ts`, message: '错'.repeat(1000) });
  }
  diagnostic.log({ message: 'final-error' });
  const report = diagnostic.snapshot();
  assert.equal(report.ffmpeg.logs[0].message, 'input-header');
  assert.equal(report.ffmpeg.logs.at(-1).message, 'final-error');
  assert.ok(new TextEncoder().encode(JSON.stringify(report)).length <= 80 * 1024);
});

test('track summaries describe input structure without retaining media URLs or encryption keys', () => {
  const summary = summarizeTracks({ video: {
    duration: 10, endList: true, segments: [
      { uri: 'https://example.test/a.ts', key: { method: 'AES-128', uri: 'https://example.test/key', iv: 'secret' } },
      { uri: 'https://example.test/b.ts', discontinuity: true, map: { uri: 'https://example.test/init' }, byteRange: { offset: 0, length: 50 } },
    ],
  }, audio: null });
  assert.equal(summary[0].segments, 2);
  assert.equal(summary[0].discontinuities, 1);
  assert.equal(summary[0].byteRanges, 1);
  assert.equal(summary[0].fragmentedMP4, true);
  assert.deepEqual(summary[0].encryption, ['AES-128', 'NONE']);
  assert.doesNotMatch(JSON.stringify(summary), /https|example|secret/);
});
