import { resolve } from 'node:path';
import { restoreArchive } from '../apps/backup-worker/archive.mjs';

// Offline drill only: verifies first, creates a fresh destination, never deploys it.
const [instanceId, archive, destination, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(instanceId ?? '') || !archive || !destination) throw new Error('Invalid arguments');
  await restoreArchive(resolve(archive), resolve(destination), instanceId);
  console.log('Recovery verified in a new isolated destination. Live activation requires operator approval.');
} catch {
  console.error('Recovery verification failed. Preserve the archive and any partial destination; review arguments, integrity, capacity and permissions.');
  process.exitCode = 1;
}
