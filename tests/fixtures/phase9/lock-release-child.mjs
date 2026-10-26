// Disposable child process: prove default Node behavior for asynchronous
// controller cleanup failures without risking the parent test runner.
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harness, request } from '../../phase2-harness.mjs';

const action = process.argv[2];
if (!['start', 'stop'].includes(action)) throw new Error('Invalid fixture action');
const root = await mkdtemp(join(tmpdir(), 'atlas-p9-controller-release-'));
const h = harness();
h.service.backupLockDirectory = root;
if (action === 'stop') h.data[0].State.Status = 'running';
h.hooks[action] = async () => {
  // Simulate protected filesystem evidence preventing removal. Never remove it.
  await writeFile(join(root, 'edge-0', 'operator-evidence'), 'retain ownership');
  console.log('release-fault-injected');
};
await h.service.reconcile();
const result = await h.service.request('edge-0', action, request());
console.log(`admitted:${result.status}`);
setTimeout(() => {
  console.log(JSON.stringify({ alive: true, ready: h.service.ready, locks: h.service.locks.size,
    operation: h.service.operations.get(result.operation.operationId)?.state }));
}, 100);
