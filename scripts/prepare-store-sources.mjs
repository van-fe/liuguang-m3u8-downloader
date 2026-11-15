import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'store', 'third-party');
const cache = path.join(root, '.cache', 'store-sources');
const scratch = path.join(root, 'work', 'store-sources', 'tmp');
await Promise.all([output, cache, scratch, path.join(output, 'archives'), path.join(output, 'evidence')].map(directory => mkdir(directory, { recursive: true })));
process.env.TEMP = scratch;
process.env.TMP = scratch;

// Immutable source snapshots matching the upstream v12.15 release recipe.
// The original x264 and LAME refs were branches; their resolved commits predate
// the 2025-01-07 release. The original build was not reproduced bit for bit.
const sources = [
  ['ffmpeg.wasm', 'ffmpegwasm/ffmpeg.wasm', 'v12.15', '71aa99d37c02a7b4c435275ca9ef50e612f6efa1', 'MIT / GPL-2.0-or-later (per component)'],
  ['ffmpeg', 'FFmpeg/FFmpeg', 'n5.1.4', '4729204c17f756e186d622060088371d10b34f7e', 'GPL-2.0-or-later for this --enable-gpl build'],
  ['x264', 'ffmpegwasm/x264', '4-cores', '33cac6b77d5b9259c552156013a817ab23119612', 'GPL-2.0-or-later'],
  ['x265', 'ffmpegwasm/x265', '3.4', '2bb5520e9596f361bf0ed81b3b8da0d7fd999069', 'GPL-2.0-or-later'],
  ['libvpx', 'ffmpegwasm/libvpx', 'v1.13.1', '10b9492dcf05b652e2e4b370e205bd605d421972', 'BSD-3-Clause and patent terms'],
  ['lame', 'ffmpegwasm/lame', 'master', '2badea1974ae36cb8312afe99cff1e6b3b5decee', 'LGPL; see source COPYING and individual file notices'],
  ['ogg', 'ffmpegwasm/Ogg', 'v1.3.4', 'bada45718453ac27b56773ae663f7e65112f6a6e', 'BSD-3-Clause'],
  ['theora', 'ffmpegwasm/theora', 'v1.1.1', '7ffd8b2ecfc2d93ae5e16028e7528e609266bfbf', 'BSD-3-Clause and source notices'],
  ['opus', 'ffmpegwasm/opus', 'v1.3.1', 'e85ed7726db5d677c9c0677298ea0cb9c65bdd23', 'BSD-3-Clause and patent terms'],
  ['vorbis', 'ffmpegwasm/vorbis', 'v1.3.3', '7798164043197d7e33f02de4353ce2aa5b248225', 'BSD-3-Clause'],
  ['zlib', 'ffmpegwasm/zlib', 'v1.2.11', 'cacf7f1d4e3d44d871b605da3b647f07d718623f', 'Zlib'],
  ['libwebp', 'ffmpegwasm/libwebp', 'v1.3.2', 'ca332209cb5567c9b249c86788cb2dbf8847e760', 'BSD-3-Clause and patent terms'],
  ['freetype', 'ffmpegwasm/freetype2', 'VER-2-10-4', '6a2b3e4007e794bfc6c91030d0ed987f925164a8', 'FTL or GPL-2.0; see source licenses'],
  ['fribidi', 'fribidi/fribidi', 'v1.0.9', 'f9e8e71a6fbf4a4619481284c9f484d10e559995', 'LGPL-2.1-or-later'],
  ['harfbuzz', 'harfbuzz/harfbuzz', '5.2.0', '4a1d891c6317d2c83e5f3c2607ec5f5ccedffcde', 'MIT-style; see source COPYING'],
  ['libass', 'libass/libass', '0.15.0', 'd149636f502f5774ae1a8fb4c554b122674393b2', 'ISC'],
  ['zimg', 'sekrit-twc/zimg', 'release-3.0.5', 'e5b0de6bebbcbc66732ed5afaafef6b2c7dfef87', 'WTFPL-2.0 and source notices'],
  ['emscripten', 'emscripten-core/emscripten', '3.1.40', '5c27e79dd0a9c4e27ef2326841698cdd4f6b5784', 'MIT / NCSA and bundled system library notices'],
  ['hls.js', 'video-dev/hls.js', 'v1.6.13', 'abb6945bd29eadc04c25b2522528ca6aa619992f', 'Apache-2.0'],
].map(([name, repository, upstreamRef, commit, license]) => ({ name, repository, upstreamRef, commit, license,
  url: `https://codeload.github.com/${repository}/tar.gz/${commit}`,
  archive: `archives/${name}-${commit.slice(0, 12)}.tar.gz`,
}));
sources.push({
  name: 'SDL2', repository: 'libsdl-org/SDL', upstreamRef: 'release-2.24.2', license: 'Zlib',
  url: 'https://codeload.github.com/libsdl-org/SDL/zip/refs/tags/release-2.24.2',
  archive: 'archives/SDL-release-2.24.2.zip',
  expectedSha512: 'b178bdc8f7c40271e09a72f639649d1d61953dda4dc12b77437259667b63b961fd3b2c67b0de6fdc5f9f9c80c49bfafd164e4c13715bc1056e550acc8bad5a3c',
});

async function fetchBytes(url) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'liuguang-source-material-preparation' }, signal: AbortSignal.timeout(240000) });
      if (!response.ok) throw new Error(`${response.status} ${url}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function githubFile(repository, commit, filename) {
  const url = `https://api.github.com/repos/${repository}/contents/${filename}?ref=${commit}`;
  const data = JSON.parse((await fetchBytes(url)).toString());
  if (data.encoding !== 'base64') throw new Error(`Expected source file: ${url}`);
  return Buffer.from(data.content, 'base64');
}

async function downloadArchive(url, destination) {
  const temporary = destination + '.part';
  await new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--silent', '--show-error', '--retry', '3',
      '--retry-delay', '1', '--connect-timeout', '20', '--max-time', '900',
      '--output', temporary, url,
    ], { windowsHide: true, env: { ...process.env, TEMP: scratch, TMP: scratch } });
    let errors = '';
    child.stderr.on('data', data => { errors += data.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Archive download failed (${code}): ${url}\n${errors}`)));
  });
  await rename(temporary, destination);
  return readFile(destination);
}

const packages = [];
for (const spec of ['@ffmpeg/core/0.12.10', '@ffmpeg/ffmpeg/0.12.15', 'hls.js/1.6.13']) {
  const metadata = JSON.parse((await fetchBytes(`https://registry.npmjs.org/${spec}`)).toString());
  packages.push({ name: metadata.name, version: metadata.version, license: metadata.license,
    gitHead: metadata.gitHead || null, dist: metadata.dist, repository: metadata.repository,
  });
}
await writeFile(path.join(output, 'evidence', 'npm-release-metadata.json'), JSON.stringify(packages, null, 2) + '\n');
const upstreamCommit = sources[0].commit;
const dockerfile = await githubFile('ffmpegwasm/ffmpeg.wasm', upstreamCommit, 'Dockerfile');
await writeFile(path.join(output, 'evidence', 'upstream-v12.15.Dockerfile'), dockerfile);
await writeFile(path.join(output, 'evidence', 'upstream-v12.15.Makefile'), await githubFile('ffmpegwasm/ffmpeg.wasm', upstreamCommit, 'Makefile'));
await writeFile(path.join(output, 'evidence', 'emscripten-3.1.40-sdl2-port.py'), await githubFile('emscripten-core/emscripten', sources.find(source => source.name === 'emscripten').commit, 'tools/ports/sdl2.py'));
const pinnedDocker = dockerfile.toString().replace(/https:\/\/github\.com\/([^\s]+?)\.git#\$([A-Z0-9_]+)/g, (url, repository) => {
  const source = sources.find(item => item.repository.toLowerCase() === repository.toLowerCase());
  if (!source) throw new Error(`Unmapped build dependency ${repository}`);
  return `https://github.com/${repository}.git#${source.commit}`;
}).replace('git clone --recursive -b $ZIMG_BRANCH https://github.com/sekrit-twc/zimg.git /src',
  `git clone --recursive https://github.com/sekrit-twc/zimg.git /src && cd /src && git checkout ${sources.find(source => source.name === 'zimg').commit} && git submodule update --init --recursive`);
await writeFile(path.join(output, 'Dockerfile.pinned'), pinnedDocker);

let next = 0;
await Promise.all(Array.from({ length: 3 }, async () => {
  while (next < sources.length) {
    const source = sources[next++];
    const destination = path.join(output, source.archive);
    let bytes;
    if (await stat(destination).catch(() => null)) bytes = await readFile(destination);
    else {
      console.log(`Downloading source: ${source.name}`);
      bytes = await downloadArchive(source.url, destination);
    }
    source.bytes = bytes.length;
    source.sha256 = createHash('sha256').update(bytes).digest('hex');
    if (source.expectedSha512) {
      source.sha512 = createHash('sha512').update(bytes).digest('hex');
      if (source.sha512 !== source.expectedSha512) throw new Error(`Official SDL port hash mismatch: ${source.archive}`);
    }
    console.log(`Source ready: ${source.name} (${(bytes.length / 1048576).toFixed(1)} MiB)`);
  }
}));

const binaries = [];
for (const [component, relative] of [
  ['@ffmpeg/core', 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.wasm'],
  ['@ffmpeg/core', 'node_modules/@ffmpeg/core/dist/esm/ffmpeg-core.js'],
  ['@ffmpeg/ffmpeg', 'node_modules/@ffmpeg/ffmpeg/dist/esm/index.js'],
  ['hls.js', 'node_modules/hls.js/dist/hls.min.js'],
]) {
  const bytes = await readFile(path.join(root, relative));
  binaries.push({ component, file: relative.replace('node_modules/', ''), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const manifest = {
  schemaVersion: 1, preparedOn: '2026-11-15',
  release: { repository: 'ffmpegwasm/ffmpeg.wasm', tag: 'v12.15', commit: upstreamCommit,
    releaseUrl: 'https://github.com/ffmpegwasm/ffmpeg.wasm/releases/tag/v12.15',
    contains: { '@ffmpeg/ffmpeg': '0.12.15', '@ffmpeg/core': '0.12.10' } },
  sourceSnapshotsDownloaded: true, reproducedBitForBit: false,
  provenanceNotes: [
    'The upstream release tag v0.12.10 is a different older release; do not use it for core 0.12.10.',
    'npm did not publish a gitHead field for the two ffmpeg packages. The upstream v12.15 release explicitly identifies their versions.',
    'The actual bundled core reports FFmpeg 5.1.4 and Emscripten 3.1.40 commit 5c27e79dd0a9c4e27ef2326841698cdd4f6b5784, matching the archived recipe.',
    'The upstream x264 4-cores branch resolves to commit 33cac6b77d5b9259c552156013a817ab23119612 (2022-08-22). LAME master resolves to 2badea1974ae36cb8312afe99cff1e6b3b5decee (2020-10-29). Both predate the 2025-01-07 release; original build attestations are unavailable.',
    'SDL 2.24.2 source archive SHA-512 is checked against the hash in the pinned Emscripten port script.',
    'Optional zimg googletest and ffmpeg.wasm testdata submodules are test inputs and are not compiled into the shipped core; they are not included.',
    'Compiler binaries, Docker base image and apt build-tool packages are build prerequisites, not redistributed runtime components in the Chrome extension.',
  ],
  binaries, packages, sources,
};
await writeFile(path.join(output, 'sources.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(path.join(output, 'SHA256SUMS.txt'), sources.map(source => `${source.sha256}  ${source.archive}`).join('\n') + '\n');
console.log(`Prepared ${sources.length} pinned source snapshots; ${(sources.reduce((sum, source) => sum + source.bytes, 0) / 1048576).toFixed(1)} MiB.`);
const packaged = spawnSync('python', [path.join(root, 'scripts', 'prepare-store-sources.py')], {
  cwd: root, encoding: 'utf8', windowsHide: true, env: { ...process.env, TEMP: scratch, TMP: scratch },
});
if (packaged.error || packaged.status !== 0) throw new Error(packaged.error?.message || packaged.stderr);
console.log(packaged.stdout.trim());
