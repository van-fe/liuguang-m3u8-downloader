import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, link, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeZip } from './lib/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = path.join(root, 'work', 'store-build');
const staging = path.join(work, 'package');
const temporary = path.join(work, 'tmp');
const output = path.join(root, 'dist', 'chrome-web-store');
const materials = path.join(output, 'materials');
const publicSite = path.join(root, 'docs');
const store = path.join(root, 'store');
const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const publisher = JSON.parse(await readFile(path.join(store, 'publisher.json'), 'utf8'));
const listing = JSON.parse(await readFile(path.join(store, 'listing', 'zh_CN.json'), 'utf8'));
const version = packageInfo.version;
const upstreamName = `liuguang-third-party-sources-${version}.zip`;
const upstreamArchive = path.join(store, 'third-party', upstreamName);

function within(target, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function removeGenerated(target, parent) {
  assert.ok(within(target, parent), `Unsafe cleanup path: ${target}`);
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
async function files(directory, prefix = '') {
  const entries = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const name = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${name}`);
    if (entry.isDirectory()) entries.push(...await files(path.join(directory, entry.name), `${name}/`));
    else if (entry.isFile()) entries.push({ name, source: path.join(directory, entry.name) });
  }
  return entries;
}
async function hash(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
async function requireFile(filename) {
  const info = await stat(filename).catch(() => null);
  assert.ok(info?.isFile() && info.size > 0, `Required release input is missing or empty: ${path.relative(root, filename)}`);
  return info;
}
function checkUrl(value, name) {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', `${name} must use HTTPS.`);
  assert.ok(!/example\.(?:com|org)|localhost|127\.0\.0\.1|<|>/.test(value), `${name} must be a real public URL.`);
}
async function png(filename, width, height, alphaAllowed = false) {
  const bytes = await readFile(filename);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `Not a PNG: ${filename}`);
  assert.equal(bytes.readUInt32BE(16), width, `Wrong image width: ${filename}`);
  assert.equal(bytes.readUInt32BE(20), height, `Wrong image height: ${filename}`);
  assert.equal(bytes[24], 8, `Expected 8-bit PNG: ${filename}`);
  assert.ok(alphaAllowed ? [2, 6].includes(bytes[25]) : bytes[25] === 2, `Screenshot/promo must be RGB without transparency: ${filename}`);
  return { filename: path.basename(filename), width, height, bytes: bytes.length, sha256: await hash(filename) };
}

assert.match(version, /^\d+\.\d+\.\d+(?:\.\d+)?$/);
assert.equal(packageInfo.license, 'GPL-2.0-or-later');
assert.equal(listing.target_version, version, 'Listing version is stale.');
for (const key of ['repositoryUrl', 'homepageUrl', 'privacyUrl', 'supportUrl', 'demoUrl']) checkUrl(publisher[key], key);
assert.equal(listing.publisher.display_name, publisher.publisher);
assert.equal(listing.publisher.privacy_policy_url, publisher.privacyUrl);
assert.ok(Array.from(listing.title).length <= 75 && listing.title.trim());
assert.ok(Array.from(listing.summary).length <= 132 && listing.summary.trim());
assert.ok(listing.description.trim());
await Promise.all([
  requireFile(path.join(root, 'LICENSE')),
  requireFile(path.join(root, 'extension', 'privacy.html')),
  requireFile(path.join(store, 'site', 'index.html')),
  requireFile(path.join(store, 'review', 'demo', 'index.html')),
  requireFile(path.join(store, 'review', 'dashboard-fields.json')),
]);
const imageManifest = JSON.parse(await readFile(path.join(store, 'assets', 'asset-manifest.json'), 'utf8'));
assert.equal(imageManifest.version, version, 'Visual assets were captured from another release.');
assert.deepEqual(imageManifest.pageErrors, [], 'Visual capture reported page errors.');
const images = [];
images.push(await png(path.join(store, 'assets', 'icon-128.png'), 128, 128, true));
for (const name of ['screenshot-01-discovery-1280x800.png', 'screenshot-02-parallel-1280x800.png', 'screenshot-03-local-settings-1280x800.png', 'screenshot-04-naming-1280x800.png']) {
  images.push(await png(path.join(store, 'assets', name), 1280, 800));
}
images.push(await png(path.join(store, 'assets', 'promo-440x280.png'), 440, 280));
images.push(await png(path.join(store, 'assets', 'marquee-1400x560.png'), 1400, 560));

await mkdir(temporary, { recursive: true });
const env = {
  ...process.env, TEMP: temporary, TMP: temporary,
  npm_config_cache: path.join(root, '.cache', 'npm'),
  NODE_COMPILE_CACHE: path.join(root, '.cache', 'node-compile'),
};
const built = spawnSync(process.execPath, [path.join(root, 'scripts', 'build.mjs')], { cwd: root, env, stdio: 'inherit', windowsHide: true });
assert.equal(built.error, undefined, built.error?.message);
assert.equal(built.status, 0, 'The ordinary extension build failed.');

try {
  await removeGenerated(staging, work);
  await removeGenerated(materials, output);
  await mkdir(staging, { recursive: true });
  await mkdir(output, { recursive: true });
  await cp(path.join(root, 'dist', 'liuguang-m3u8'), staging, {
    recursive: true,
    filter: source => !['README.md', 'SITE_TEST_RESULTS.md'].includes(path.basename(source)),
  });
  await cp(path.join(store, 'assets', 'icon-128.png'), path.join(staging, 'assets', 'icon128.png'));
  const manifestPath = path.join(staging, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(manifest.version, version);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, listing.title);
  manifest.description = listing.summary;
  manifest.homepage_url = publisher.homepageUrl;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  const sourceText = `# Source code and licensing\n\nLiuguang M3U8 Video Downloader ${version}\n\nProject code: GPL-2.0-or-later. See LICENSE. Third-party components retain their own licenses and notices.\n\n- Repository: ${publisher.repositoryUrl}\n- Release source: ${publisher.repositoryUrl}/tree/v${version}\n- Project source ZIP: ${publisher.repositoryUrl}/archive/refs/tags/v${version}.zip\n- Corresponding third-party source bundle: ${publisher.repositoryUrl}/releases/download/v${version}/${upstreamName}\n- Source inventory and build instructions: ${publisher.repositoryUrl}/tree/v${version}/store/third-party\n- Third-party notices: THIRD_PARTY_NOTICES.md and licenses/\n- Privacy policy: ${publisher.privacyUrl}\n- Support and source requests: ${publisher.supportUrl}\n\nThe FFmpeg WebAssembly binary is copied unmodified from @ffmpeg/core 0.12.10. Its wrapper and HLS library are packaged locally. The source bundle includes pinned upstream snapshots, build files, license texts and provenance evidence. Consult its audit notes for reproducibility limits; source availability is not a claim of a bit-identical rebuild.\n`;
  await writeFile(path.join(staging, 'SOURCE_CODE.md'), sourceText);
  const packageFiles = await files(staging);
  const paths = new Set(packageFiles.map(entry => entry.name));
  const canonicalRuntime = new Set((await files(path.join(root, 'extension'))).map(entry => entry.name));
  for (const name of ['manifest.json', 'privacy.html', 'LICENSE', 'SOURCE_CODE.md', 'THIRD_PARTY_NOTICES.md', 'background.js', 'offscreen.js', 'vendor/ffmpeg-core/ffmpeg-core.wasm', 'vendor/ffmpeg-core/ffmpeg-core.js']) assert.ok(paths.has(name), `Missing runtime file ${name}`);
  for (const name of paths) {
    assert.ok(!name.split('/').some(part => part.startsWith('.')) && !/(?:^|\/)(?:work|test-results|node_modules|profile|profiles)(?:\/|$)|\.(?:crx|pem|key)$/i.test(name), `Unexpected private/development package entry: ${name}`);
    assert.ok(canonicalRuntime.has(name) || ['LICENSE', 'SOURCE_CODE.md', 'THIRD_PARTY_NOTICES.md'].includes(name) || /^assets\/icon(?:16|32|48|128)\.png$/.test(name) || name.startsWith('licenses/') || name.startsWith('vendor/ffmpeg/') || name.startsWith('vendor/ffmpeg-core/') || name === 'vendor/hls/hls.min.js', `Unexpected stale build entry: ${name}`);
  }
  assert.ok(manifest.content_security_policy.extension_pages.includes("'wasm-unsafe-eval'"));
  assert.ok(!/(?:^|\s)'unsafe-eval'(?:\s|;|$)/.test(manifest.content_security_policy.extension_pages));
  const remoteScriptReferences = [];
  for (const entry of packageFiles.filter(entry => !entry.name.startsWith('vendor/') && /\.(?:js|html)$/.test(entry.name))) {
    const content = await readFile(entry.source, 'utf8');
    if (/<script\b[^>]*\bsrc\s*=\s*["']https?:\/\//i.test(content) || /(?:\bimport\s*\(|\bimportScripts\s*\()\s*["']https?:\/\//.test(content)) remoteScriptReferences.push(entry.name);
  }
  assert.deepEqual(remoteScriptReferences, [], 'Executable remote script references found.');
  const uploadName = `liuguang-m3u8-${version}.zip`;
  const uploadZip = path.join(output, uploadName);
  await writeZip(uploadZip, packageFiles);

  // This directory is generated solely from the store source pages and demos.
  await removeGenerated(publicSite, root);
  await mkdir(publicSite, { recursive: true });
  await cp(path.join(store, 'site'), publicSite, { recursive: true });
  await cp(path.join(root, 'extension', 'privacy.html'), path.join(publicSite, 'privacy.html'));
  await cp(path.join(store, 'review', 'demo'), path.join(publicSite, 'demo'), { recursive: true });
  await mkdir(path.join(publicSite, 'assets'), { recursive: true });
  for (const image of images) await cp(path.join(store, 'assets', image.filename), path.join(publicSite, 'assets', image.filename));
  await writeFile(path.join(publicSite, '.nojekyll'), '');

  await mkdir(materials, { recursive: true });
  await cp(path.join(store, 'listing'), path.join(materials, 'listing'), { recursive: true });
  await cp(path.join(store, 'review'), path.join(materials, 'review'), { recursive: true });
  await cp(publicSite, path.join(materials, 'site'), { recursive: true });
  await mkdir(path.join(materials, 'assets'), { recursive: true });
  for (const image of images) await cp(path.join(store, 'assets', image.filename), path.join(materials, 'assets', image.filename));
  for (const filename of ['asset-manifest.json', 'ASSETS.txt']) await cp(path.join(store, 'assets', filename), path.join(materials, 'assets', filename));
  await cp(path.join(store, 'third-party'), path.join(materials, 'third-party'), {
    recursive: true,
    filter: source => !source.includes(`${path.sep}archives${path.sep}`) && path.basename(source) !== 'archives' && !/\.(?:zip|gz|xz|bz2|7z|tar)$/i.test(source),
  });
  for (const filename of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(path.join(root, filename), path.join(materials, filename));
  await cp(path.join(store, 'publisher.json'), path.join(materials, 'publisher.json'));
  await cp(path.join(store, 'UPLOAD-GUIDE.md'), path.join(materials, 'UPLOAD-GUIDE.md'));
  await writeFile(path.join(materials, 'SOURCE_CODE.md'), sourceText);
  const materialName = `liuguang-store-materials-${version}.zip`;
  const materialZip = path.join(output, materialName);
  await writeZip(materialZip, await files(materials));

  // The source collection can finish independently of the small submission kit.
  // A hard link avoids duplicating the large, immutable source archive on E.
  const releaseSource = path.join(output, upstreamName);
  const upstreamReady = await stat(upstreamArchive).then(info => info.isFile() && info.size > 0).catch(() => false);
  if (upstreamReady) {
    await rm(releaseSource, { force: true });
    await link(upstreamArchive, releaseSource).catch(() => cp(upstreamArchive, releaseSource));
  }
  const releaseAssets = [];
  for (const filename of [uploadName, materialName, ...(upstreamReady ? [upstreamName] : [])]) {
    const fullPath = path.join(output, filename);
    releaseAssets.push({ filename, bytes: (await stat(fullPath)).size, sha256: await hash(fullPath) });
  }
  const report = {
    version, publisher: publisher.publisher, repository: publisher.repositoryUrl,
    created_at: new Date().toISOString(),
    upload_package: uploadName, upload_entry_count: packageFiles.length,
    materials_package: materialName, release_assets: releaseAssets,
    public_urls: { homepage: publisher.homepageUrl, privacy: publisher.privacyUrl, support: publisher.supportUrl, demo: publisher.demoUrl },
    listing_lengths: { title: Array.from(listing.title).length, summary: Array.from(listing.summary).length, description: Array.from(listing.description).length },
    images,
    checks: { root_manifest: true, manifest_v3: true, versions_match: true, privacy_packaged: true, project_license_packaged: true, source_links_packaged: true, packaged_wasm: true, no_detected_remote_script_reference: true, no_development_or_private_files: true, image_headers_valid: true, third_party_source_archive_prepared: upstreamReady },
    remaining_publisher_actions: [...(upstreamReady ? [] : ['Finish the corresponding third-party source bundle and run this build again before publishing.']), 'Publish and verify the public privacy, support and corresponding-source URLs.', 'Register and verify the Chrome Web Store developer account, including the real account contact details.', 'Review the prepared data-use certifications and distribution choices.', 'Upload only the extension ZIP to the item and explicitly submit it for review.'],
    scope: 'Local build and static-site generation only. This command does not upload, submit for review, accept agreements, pay fees, or publish anything.',
  };
  await writeFile(path.join(output, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
  await writeFile(path.join(output, 'SHA256SUMS'), releaseAssets.map(asset => `${asset.sha256}  ${asset.filename}`).join('\n') + '\n');
  console.log(`Chrome Web Store upload ZIP: ${uploadZip}\nSubmission materials: ${materialZip}\nThird-party sources: ${upstreamReady ? releaseSource : 'pending independent source collection'}\nBuild report: ${path.join(output, 'build-report.json')}\nGenerated GitHub Pages site: ${publicSite}`);
} finally {
  await removeGenerated(staging, work);
  await removeGenerated(temporary, work);
}
