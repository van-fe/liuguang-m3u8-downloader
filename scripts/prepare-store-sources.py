"""Extract upstream license texts and package the prepared source snapshots.

Only reads archive members; never extracts arbitrary source archive paths.
All generated paths must remain inside the explicit E-drive materials folder.
"""
import hashlib
import base64
import json
import pathlib
import re
import sys
import tarfile
import zipfile

root = pathlib.Path(__file__).resolve().parent.parent
output = (root / 'store' / 'third-party').resolve()
assert output.is_relative_to(root) and output.drive.lower() == root.drive.lower()
manifest = json.loads((output / 'sources.json').read_text(encoding='utf-8'))
names = re.compile(r'(^|[._-])(licen[sc]es?|copying|copyrights?|notices?|patents?|authors|credits)([._-]|$)|^(?:FTL|[AL]?GPLv?[0-9.-]*|BSD|ZLIB)(?:\.[a-z0-9]+)?$', re.I)
license_index = []


def file_hash(file_path, algorithm='sha256'):
    digest = hashlib.new(algorithm)
    with file_path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


published_package = root / '.cache' / 'store-sources' / 'core-0.12.10.npm.tgz'
if published_package.is_file():
    metadata = next(item for item in manifest['packages'] if item['name'] == '@ffmpeg/core')
    expected_integrity = metadata['dist']['integrity']
    digest = hashlib.sha512()
    with published_package.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if 'sha512-' + base64.b64encode(digest.digest()).decode() != expected_integrity:
        raise ValueError('Official npm package integrity mismatch')
    matches = []
    with tarfile.open(published_package, 'r:gz') as package:
        for name in ['ffmpeg-core.js', 'ffmpeg-core.wasm']:
            published = package.extractfile('package/dist/esm/' + name).read()
            installed = (root / 'node_modules' / '@ffmpeg' / 'core' / 'dist' / 'esm' / name).read_bytes()
            if published != installed:
                raise ValueError(f'Installed core differs from published npm package: {name}')
            matches.append({'file': name, 'sha256': hashlib.sha256(published).hexdigest(), 'matchesPublishedPackage': True})
    verification = {'package': '@ffmpeg/core', 'version': metadata['version'], 'npmIntegrityVerified': True,
                    'publishedPackageIntegrity': expected_integrity, 'esmFiles': matches}
    (output / 'evidence' / 'published-core-package-verification.json').write_text(json.dumps(verification, indent=2) + '\n', encoding='utf-8')


def save_license(component, member_name, data):
    relative = pathlib.PurePosixPath(member_name)
    if relative.is_absolute() or '..' in relative.parts or len(relative.parts) < 2:
        raise ValueError(f'Unsafe archive path: {member_name}')
    destination = (output / 'licenses' / component / pathlib.Path(*relative.parts[1:])).resolve()
    assert destination.is_relative_to(output / 'licenses')
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(data)
    license_index.append({'component': component, 'file': destination.relative_to(output).as_posix(),
                          'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)})


for source in manifest['sources']:
    archive_path = output / source['archive']
    checksum = file_hash(archive_path)
    if checksum != source['sha256']:
        raise ValueError(f'Archive hash mismatch: {archive_path.name}')
    if archive_path.suffix == '.zip':
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.infolist():
                if not member.is_dir() and names.search(pathlib.PurePosixPath(member.filename).name):
                    save_license(source['name'], member.filename, archive.read(member))
    else:
        with tarfile.open(archive_path, 'r:gz') as archive:
            for member in archive:
                if member.isfile() and names.search(pathlib.PurePosixPath(member.name).name):
                    stream = archive.extractfile(member)
                    save_license(source['name'], member.name, stream.read())

(output / 'license-index.json').write_text(json.dumps(license_index, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
bundle_name = 'liuguang-third-party-sources-1.2.11.zip'
bundle = output / bundle_name
with zipfile.ZipFile(bundle, 'w', compression=zipfile.ZIP_STORED, allowZip64=True) as archive:
    for source_file in sorted(output.rglob('*')):
        if not source_file.is_file() or source_file == bundle or source_file.name == 'SOURCE_BUNDLE.sha256' or source_file.suffix == '.part':
            continue
        archive.write(source_file, source_file.relative_to(output).as_posix())
checksum = file_hash(bundle)
(output / 'SOURCE_BUNDLE.sha256').write_text(f'{checksum}  {bundle_name}\n', encoding='ascii')
print(json.dumps({'bundle': str(bundle), 'bytes': bundle.stat().st_size, 'sha256': checksum,
                  'source_archives': len(manifest['sources']), 'license_texts': len(license_index)}))
