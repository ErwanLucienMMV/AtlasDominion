import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, lstat, readFile, writeFile, statfs } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathsOverlap } from '../../libs/filesystem-paths.mjs';

const safe = name => typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.includes(':') && !name.includes('\0') && name.split('/').every(p => p && p !== '.' && p !== '..');
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function inventory(root, prefix = '') {
  if (!(await lstat(root)).isDirectory() || (await lstat(root)).isSymbolicLink()) throw new Error('Unsafe source');
  const entries = [];
  for (const name of (await readdir(root)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (!safe(relative)) throw new Error('Unsafe filename');
    const path = join(root, name), info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || info.nlink > 1 && info.isFile()) throw new Error('Links and special files unsupported');
    if (info.isDirectory()) entries.push({ path: relative, type: 'directory' }, ...await inventory(path, relative));
    else entries.push({ path: relative, type: 'file', size: info.size, sha256: await digest(path) });
  }
  return entries;
}
export async function createArchive(source, destination, instanceId, minimumFreeBytes = 0) {
  if (pathsOverlap(source, destination)) throw new Error('Archive overlaps source');
  const entries = await inventory(source);
  const space = await statfs(resolve(destination, '..'));
  if (space.bavail * space.bsize < entries.reduce((n, e) => n + (e.size ?? 0), 0) * 2 + minimumFreeBytes) throw new Error('Insufficient backup capacity');
  await mkdir(destination);
  await mkdir(join(destination, 'data'));
  for (const entry of entries) {
    if (entry.type === 'directory') await mkdir(join(destination, 'data', entry.path));
    else await pipeline(createReadStream(join(source, entry.path)), createWriteStream(join(destination, 'data', entry.path), { flags: 'wx', mode: 0o600 }));
  }
  if (JSON.stringify(await inventory(source)) !== JSON.stringify(entries)) throw new Error('Source changed during backup');
  const manifest = { version: 1, instanceId, createdAt: new Date().toISOString(), entries };
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
  await verifyArchive(destination, instanceId);
  return manifest;
}
export async function verifyArchive(archive, instanceId) {
  const root = await lstat(archive);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Unsafe archive root');
  const manifest = JSON.parse(await readFile(join(archive, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.instanceId !== instanceId || !Array.isArray(manifest.entries) ||
    manifest.entries.some(e => !safe(e.path)) || new Set(manifest.entries.map(e => e.path)).size !== manifest.entries.length) throw new Error('Invalid manifest');
  if (JSON.stringify(await inventory(join(archive, 'data'))) !== JSON.stringify(manifest.entries)) throw new Error('Archive integrity failure');
  return manifest;
}
// Always creates a new destination; never overwrites an active world.
export async function restoreArchive(archive, destination, instanceId) {
  const manifest = await verifyArchive(archive, instanceId);
  await mkdir(destination);
  for (const entry of manifest.entries) {
    if (entry.type === 'directory') await mkdir(join(destination, entry.path));
    else await pipeline(createReadStream(join(archive, 'data', entry.path)), createWriteStream(join(destination, entry.path), { flags: 'wx', mode: 0o600 }));
  }
  if (JSON.stringify(await inventory(destination)) !== JSON.stringify(manifest.entries)) throw new Error('Restoration verification failed');
  return manifest;
}
