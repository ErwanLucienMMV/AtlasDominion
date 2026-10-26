import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../libs/instance-lock.mjs';
import { actor, harness, request, until } from './phase2-harness.mjs';

for (const action of ['start', 'stop']) test(`completed ${action} retains ownership and unhealthy readiness after cleanup failure`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-p9-cleanup-'));
  const h = harness(); h.service.backupLockDirectory = directory;
  if (action === 'stop') h.data[0].State.Status = 'running';
  h.hooks[action] = () => writeFile(join(directory, 'edge-0', 'evidence'), 'retain this evidence');
  await h.service.reconcile();
  const result = await h.service.request('edge-0', action, request());
  await until(() => h.service.failedReleases.has('edge-0'));
  assert.equal(h.service.operation(result.operation.operationId, actor).state, 'completed');
  assert.equal(h.service.operation(result.operation.operationId, actor).result, 'changed');
  assert.equal(h.events.at(-1).outcome, 'completed');
  assert.equal(h.service.ready, false);
  assert.equal(h.service.locks.get('edge-0'), result.operation.operationId);
  assert.equal(h.service.diskLocks.has('edge-0'), true);
  assert.equal(await readFile(join(directory, 'edge-0', 'evidence'), 'utf8'), 'retain this evidence');
  await h.service.reconcile();
  assert.equal(h.service.ready, false, 'healthy Docker cannot repair failed filesystem cleanup');
  await assert.rejects(h.service.request('edge-1', 'start', request('cleanup-blocked-0001')), { code: 'DOCKER_UNAVAILABLE' });
  const replay = await h.service.request('edge-0', action, request());
  assert.equal(replay.operation.state, 'completed', 'idempotent replay preserves the actual Engine outcome');
  assert.equal(h.calls.filter(call => call[0] === action).length, 1);
});

test('synchronous completion cleanup failure returns a sanitized error and retains ownership', async () => {
  const h = harness(); await h.service.reconcile();
  let releases = 0;
  h.service.diskLocks.set('edge-0', async () => {
    releases++;
    if (releases === 1) throw new Error('private/filesystem/path: ENOTEMPTY');
  });
  await assert.rejects(h.service.request('edge-0', 'stop', request()), error => {
    assert.equal(error.code, 'DOCKER_UNAVAILABLE');
    assert.doesNotMatch(error.message, /private|ENOTEMPTY/);
    return true;
  });
  assert.equal(releases, 1, 'request cleanup must not implicitly retry failed removal');
  assert.equal(h.service.locks.size, 1);
  await h.service.reconcile();
  assert.equal(h.service.ready, false);
});

test('explicit successful cleanup retry clears failure ownership before health recovers', async () => {
  const h = harness(); await h.service.reconcile();
  let fail = true;
  h.service.locks.set('edge-0', 'synthetic-operation');
  h.service.diskLocks.set('edge-0', async () => { if (fail) throw new Error('private I/O failure'); });
  await assert.rejects(h.service.unlock('edge-0'), { code: 'DOCKER_UNAVAILABLE' });
  await h.service.reconcile(); assert.equal(h.service.ready, false);
  fail = false;
  await h.service.unlock('edge-0');
  assert.equal(h.service.failedReleases.size, 0);
  assert.equal(h.service.diskLocks.size, 0);
  assert.equal(h.service.locks.size, 0);
  assert.equal(h.service.ready, false, 'release alone does not certify Engine health');
  await h.service.reconcile(); assert.equal(h.service.ready, true);
});

test('failed persistent release shares rejection and preserves evidence across concurrent calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-p9-release-evidence-'));
  const release = await acquireInstanceLock(directory, 'approved');
  await writeFile(join(directory, 'approved', 'evidence'), 'preserve');
  const attempts = Array.from({ length: 16 }, () => release());
  assert.equal(new Set(attempts).size, 1, 'concurrent calls share the same release promise');
  const results = await Promise.allSettled(attempts);
  assert.equal(results.every(result => result.status === 'rejected'), true);
  assert.equal(await readFile(join(directory, 'approved', 'evidence'), 'utf8'), 'preserve');
  await assert.rejects(acquireInstanceLock(directory, 'approved'));
});

test('released owner cannot delete a subsequently acquired persistent lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-p9-release-owner-'));
  const release = await acquireInstanceLock(directory, 'approved');
  await Promise.all(Array.from({ length: 16 }, () => release()));
  const next = await acquireInstanceLock(directory, 'approved');
  await release();
  assert.deepEqual(await readdir(directory), ['approved']);
  await next();
  assert.deepEqual(await readdir(directory), []);
});
