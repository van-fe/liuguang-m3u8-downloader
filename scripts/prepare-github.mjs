import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Prepare only reviewed project files. This script never authenticates or pushes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'work', 'store-publish', 'repo');
const allowed = ['.gitignore', '.gitattributes', 'LICENSE', 'COPYRIGHT', 'README.md', 'THIRD_PARTY_NOTICES.md', 'SITE_TEST_RESULTS.md', 'package.json', 'package-lock.json', 'extension', 'licenses', 'scripts', 'tests', 'store', 'docs'];
assert.ok(output.startsWith(root + path.sep));
await mkdir(output, { recursive: true });
const excluded = source => {
  const relative = path.relative(root, source).replaceAll(path.sep, '/');
  return relative.startsWith('store/third-party/archives') ||
    (relative.startsWith('store/third-party/') && /\.(?:zip|gz|xz|bz2|7z|tar)$/i.test(relative)) ||
    relative.startsWith('store/assets/raw') || relative.split('/').some(part => ['.git', '.cache', '.codex', '.agents', 'node_modules', 'test-results', 'work'].includes(part));
};
for (const name of allowed) {
  const source = path.join(root, name);
  assert.ok(await stat(source).catch(() => null), `Missing public project input: ${name}`);
  await cp(source, path.join(output, name), { recursive: true, force: true, filter: sourcePath => !excluded(sourcePath) });
}
const manifest = [];
async function inspect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const name = `${prefix}${entry.name}`;
    const filename = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Unexpected public symlink: ${name}`);
    if (entry.isDirectory()) await inspect(filename, `${name}/`);
    else {
      const bytes = await readFile(filename);
      if (/\.(?:mjs|js|json|md|txt|html|yml|yaml)$/.test(name)) {
        const content = bytes.toString('utf8');
        assert.ok(!/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(content), `Possible credential in public file: ${name}`);
      }
      assert.ok(bytes.length < 50 * 1024 * 1024, `Use a Release asset for large binaries: ${name}`);
      manifest.push({ path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await inspect(output);
manifest.sort((a, b) => a.path.localeCompare(b.path));
await writeFile(path.join(root, 'work', 'store-publish', 'publish-manifest.json'), JSON.stringify({ repository: 'van-fe/liuguang-m3u8-downloader', files: manifest }, null, 2));
console.log(`Prepared ${manifest.length} reviewed files (${manifest.reduce((sum, file) => sum + file.bytes, 0)} bytes): ${output}`);
