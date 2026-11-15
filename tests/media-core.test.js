import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import createFFmpegCore from '../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js';
import { createJobDiagnostic } from '../extension/lib/diagnostics.js';
import { boundDiagnosticReport } from '../extension/lib/diagnostic-store.js';

test('installed FFmpeg core logs bare Aborted() for ordinary success and failure; exit code distinguishes them', async () => {
  globalThis.self ||= { location: { href: import.meta.url } };
  const wasmBinary = await readFile(new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url));
  const aborts = [];
  const core = await createFFmpegCore({ wasmBinary, onAbort: reason => aborts.push(reason) });
  let logs = [];
  core.setLogger(({ message }) => logs.push(message));
  core.exec('-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:r=2',
    '-t', '0.5', '-c:v', 'libx264', '-movflags', '+faststart', 'valid.mp4');
  assert.equal(core.ret, 0);
  assert.ok(core.FS.stat('valid.mp4').size > 100);
  assert.equal(logs.at(-1), 'Aborted()');
  assert.equal(aborts.at(-1), '');
  core.reset();
  assert.equal(core.ret, -1);
  logs = [];
  core.exec('-hide_banner', '-loglevel', 'warning', '-i', 'missing-input.ts', '-c', 'copy', 'invalid.mp4');
  assert.equal(core.ret, 1);
  assert.ok(logs.some(line => /missing-input\.ts: No such file/.test(line)));
  assert.equal(logs.at(-1), 'Aborted()');
  core.reset();
  logs = [];
  core.exec('-hide_banner', '-loglevel', 'error', '-version');
  assert.equal(core.ret, 0, 'Reset followed by another ordinary command remains usable.');
  assert.equal(logs.at(-1), 'Aborted()');
});

test('real FFmpeg info metadata cannot leak encoded addresses, domains, or private titles into exported diagnostics', async () => {
  globalThis.self ||= { location: { href: import.meta.url } };
  const wasmBinary = await readFile(new URL('../node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm', import.meta.url));
  // Use a fresh core so this regression never changes another test's logger.
  const core = await createFFmpegCore({ wasmBinary });
  const encodedAddress = 'https%3A%2F%2Fprivate.example%2Fsecret%2Fvideo.m3u8%3Ftoken%3Dcredential';
  const bareAddress = 'private.example/secret/video.m3u8?key=credential';
  const htmlAddress = 'https&#58;&#47;&#47;private.example/secret/video.m3u8';
  const privateTitle = 'private-title-must-not-appear';
  core.exec('-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=s=16x16:r=2',
    '-t', '0.5', '-c:v', 'libx264', '-movflags', '+use_metadata_tags',
    '-metadata', `comment=${encodedAddress}`, '-metadata', `description=${bareAddress}`,
    '-metadata', `title=${privateTitle}`, '-metadata', `custom_link=${htmlAddress}`, 'metadata-input.mp4');
  assert.equal(core.ret, 0);
  core.reset();

  const rawLogLines = [];
  const collector = createJobDiagnostic({ id: 'job-metadata-regression', format: 'hls' }, {});
  core.setLogger(entry => { rawLogLines.push(entry.message); collector.log(entry); });
  core.exec('-hide_banner', '-loglevel', 'info', '-nostats', '-i', 'metadata-input.mp4', '-c', 'copy', 'output.mp4');
  assert.equal(core.ret, 0);
  // Ensure this exercises actual metadata printed by the shipped WASM core.
  assert.ok(rawLogLines.some(line => line.includes(encodedAddress)));
  assert.ok(rawLogLines.some(line => line.includes(bareAddress)));
  assert.ok(rawLogLines.some(line => line.includes(privateTitle)));
  assert.ok(rawLogLines.some(line => line.includes(htmlAddress)));

  collector.report.ffmpeg.exitCode = core.ret;
  const snapshot = collector.snapshot();
  const persisted = boundDiagnosticReport('job-metadata-regression', snapshot);
  for (const report of [snapshot, persisted]) {
    const text = JSON.stringify(report);
    for (const forbidden of ['private.example', 'secret', 'credential', 'https%3A', '&#58;', privateTitle]) {
      assert.ok(!text.includes(forbidden), `Diagnostic leaked ${forbidden}`);
    }
    assert.ok(report.ffmpeg.ignoredMetadataLines > 0);
    assert.ok(report.ffmpeg.logs.some(entry => /Stream.*Video/.test(entry.message)), 'Technical stream information should remain available.');
    assert.equal(report.ffmpeg.exitCode, 0);
  }
});
