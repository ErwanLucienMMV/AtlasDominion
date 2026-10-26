import { mkdir, rmdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';

// Persistent, non-expiring ownership: a crash requires operator investigation.
export async function acquireInstanceLock(directory, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error('Invalid instance ID');
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('Invalid lock directory');
  const path = join(directory, id);
  await mkdir(path);
  let released = false, pending;
  return () => {
    if (released) return Promise.resolve();
    // Concurrent callers share one removal. A failed release retains ownership;
    // a later explicit retry may succeed after operator investigation.
    if (!pending) pending = rmdir(path).then(() => { released = true; }, error => {
      pending = undefined; throw error;
    });
    return pending;
  };
}
