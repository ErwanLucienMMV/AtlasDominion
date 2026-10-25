import { readFile } from 'node:fs/promises';
import Docker from 'dockerode';
import { loadRegistry } from '../docker-controller/registry.mjs';
import { DockerAccess } from '../docker-controller/docker.mjs';
import { BackupWorker } from './worker.mjs';
import { restoreArchive } from './archive.mjs';

try {
  if (process.argv[2] === 'restore') {
    if (process.argv.length !== 6) throw new Error('Expected archive, fresh destination and instance ID');
    await restoreArchive(process.argv[3], process.argv[4], process.argv[5]);
    console.log('Restoration verified in fresh destination; active world was not changed.');
  } else {
    if (process.argv.length !== 2) throw new Error('Unknown operation');
    const config = JSON.parse(await readFile(process.env.BACKUP_CONFIG_FILE, 'utf8'));
    if (!Array.isArray(config.bindingAddresses) || !config.bindingAddresses.length) throw new Error('Binding addresses required');
    const worker = new BackupWorker({ config, instances: await loadRegistry(process.env.REGISTRY_DIRECTORY),
      docker: new DockerAccess(new Docker({ socketPath: '/var/run/docker.sock', timeout: 30000 }), config.bindingAddresses) }).start();
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => worker.stop());
  }
} catch {
  console.error('Backup operation failed: inspect protected configuration and retained archive evidence.');
  process.exitCode = 1;
}
