import { mkdir, rmdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Persistent, non-expiring ownership: a crash requires operator investigation.
export async function acquireInstanceLock(directory, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error('Invalid instance ID');
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('Invalid lock directory');
  const path = join(directory, id);
  await mkdir(path);
  let released = false;
  return async () => { if (!released) { await rmdir(path); released = true; } };
}
