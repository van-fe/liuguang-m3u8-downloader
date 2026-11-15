import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo');
const scratch = path.join(project, 'work', 'store-copy', 'tmp');
await Promise.all([output, scratch].map(directory => mkdir(directory, { recursive: true })));
process.env.TEMP = scratch;
process.env.TMP = scratch;

function native(program, args) {
  const result = spawnSync(program, args, {
    encoding: 'utf8', cwd: output, windowsHide: true,
    env: { ...process.env, TEMP: scratch, TMP: scratch },
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

for (const [stem, pattern, frequency] of [
  ['sample', 'testsrc2=size=320x180:rate=12', 440],
  ['sample-b', 'smptebars=size=320x180:rate=12', 660],
]) {
  native('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', pattern,
    '-f', 'lavfi', '-i', `sine=frequency=${frequency}:sample_rate=48000`,
    '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '12',
    '-c:a', 'aac', '-f', 'hls', '-hls_time', '1', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', `${stem}-%02d.ts`, `${stem}.m3u8`]);
}
native('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', 'sample.m3u8',
  '-c', 'copy', '-movflags', '+faststart', 'demo.mp4']);
const info = JSON.parse(native('ffprobe', ['-v', 'error', '-show_entries',
  'stream=codec_name,codec_type:format=duration', '-of', 'json', 'demo.mp4']));
assert.ok(info.streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264'));
assert.ok(info.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
assert.ok(Number(info.format.duration) >= 3.9);
native('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'demo.mp4', '-f', 'null', '-']);
console.log(JSON.stringify({ output, duration: Number(info.format.duration), filesGenerated: 11 }));
