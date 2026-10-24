import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { validateRegistry } from '../../libs/server-registry/index.mjs';

// The administrator-owned directory must remain read-only for the service lifetime.
export async function loadRegistry(directory) {
  const root = resolve(directory);
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('Unsafe registry directory');
  const entries = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Registry symlinks forbidden');
    if (!name.endsWith('.json')) continue;
    if (!stat.isFile() || stat.size > 65536) throw new Error('Invalid registry file');
    entries.push(JSON.parse(await readFile(path, 'utf8')));
  }
  return validateRegistry(entries);
}
