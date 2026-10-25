import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { AuditLog } from '../apps/docker-controller/audit.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { createArchive } from '../apps/backup-worker/archive.mjs';
import { acquireInstanceLock } from '../libs/instance-lock.mjs';
import { harness, actor, policy, request, until } from './phase2-harness.mjs';

function restart(h, audit, backupLockDirectory) {
  return new ControllerService({ instances: h.instances, docker: h.service.docker, policy: policy(), audit,
    capacity: { memoryMiB: 1000, cpuUnits: 10 }, timeoutMs: 2000, stopTimeoutSeconds: 1, backupLockDirectory });
}

test('daemon outage fails closed, recovery reconciles without restarting running games', async () => {
  const h = harness(); h.data[0].State.Status = 'running'; await h.service.reconcile();
  h.hooks.inspect = async () => { throw new Error('private daemon failure'); };
  await assert.rejects(h.service.reconcile(), { code: 'DOCKER_UNAVAILABLE' });
  assert.equal(h.service.ready, false);
  await assert.rejects(h.service.request(h.instances[1].id, 'start', request()), { code: 'DOCKER_UNAVAILABLE' });
  assert.equal(h.calls.some(c => ['start', 'stop'].includes(c[0])), false);
  h.hooks.inspect = null; await h.service.reconcile();
  assert.equal(h.service.ready, true); assert.ok(h.service.reservations.has(h.instances[0].id));
  assert.equal((await h.service.status(h.instances[0].id, actor)).docker, 'running');
  const result = await h.service.request(h.instances[1].id, 'start', request('recovered-request-001'));
  await until(() => h.service.locks.size === 0);
  assert.equal(h.service.operation(result.operation.operationId, actor).state, 'completed');
  assert.deepEqual(h.calls.filter(c => c[0] === 'start'), [['start', h.data[1].Id]]);
});

test('cold application restart replays durable intent and observes rebooted containers without automatic starts', async () => {
  const h = harness(), directory = await mkdtemp(join(tmpdir(), 'atlas-phase9-audit-'));
  h.service.audit = new AuditLog(directory); await h.service.reconcile();
  await h.service.request(h.instances[0].id, 'start', request()); await until(() => h.service.locks.size === 0);
  await h.service.request(h.instances[1].id, 'stop', request('stopped-intent-0001')); await until(() => h.service.locks.size === 0);
  // Model Engine after reboot: restart:no leaves both containers stopped.
  h.data[0].State.Status = 'exited';
  const audit = new AuditLog(directory), service = restart(h, audit);
  service.desired = await audit.desiredStates(service.instances);
  const mutations = h.calls.filter(c => ['start', 'stop'].includes(c[0])).length;
  await service.reconcile();
  assert.equal(service.ready, true); assert.equal(service.reservations.size, 0);
  assert.equal(service.desired.get(h.instances[0].id), 'wanted_running');
  assert.equal(service.desired.get(h.instances[1].id), 'wanted_stopped');
  assert.equal(h.calls.filter(c => ['start', 'stop'].includes(c[0])).length, mutations);
  assert.match(service.monitoring.render(service), /atlas_instance_wanted_running\{instance="edge-0",game_type="unknown-compatible-game"\} 1/);
  assert.equal((await service.status(h.instances[1].id, actor)).desired, 'wanted_stopped');
});

test('restart preserves persistent backup exclusion until its owner explicitly releases it', async () => {
  const h = harness(), directory = await mkdtemp(join(tmpdir(), 'atlas-phase9-lock-'));
  const release = await acquireInstanceLock(directory, h.instances[0].id);
  const service = restart(h, h.service.audit, directory); await service.reconcile();
  await assert.rejects(service.request(h.instances[0].id, 'start', request()), { code: 'OPERATION_CONFLICT' });
  assert.equal((await readdir(directory)).length, 1); assert.equal(h.calls.some(c => c[0] === 'start'), false);
  await release();
  await service.request(h.instances[0].id, 'start', request('released-owner-001')); await until(() => service.locks.size === 0);
  assert.equal((await readdir(directory)).length, 0);
});

test('recovery CLI verifies bytes in a fresh destination and preserves existing data and damaged evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-phase9-restore-'));
  const source = join(root, 'source'), archive = join(root, 'archive'), restored = join(root, 'restored');
  await mkdir(source); await writeFile(join(source, 'world.dat'), 'synthetic world bytes');
  await createArchive(source, archive, 'drill-world');
  const script = fileURLToPath(new URL('../scripts/verify-recovery.mjs', import.meta.url));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.ifError(result.error); return result;
  };
  assert.equal(run('drill-world', archive, restored).status, 0);
  assert.equal(await readFile(join(restored, 'world.dat'), 'utf8'), 'synthetic world bytes');
  assert.equal(run('drill-world', archive, restored).status, 1);
  assert.equal(await readFile(join(restored, 'world.dat'), 'utf8'), 'synthetic world bytes');
  assert.equal(run('wrong-instance', archive, join(root, 'wrong')).status, 1);
  assert.ok(!(await readdir(root)).includes('wrong'));
  await writeFile(join(archive, 'data', 'world.dat'), 'damaged sentinel');
  const result = run('drill-world', archive, join(root, 'corrupt'));
  assert.equal(result.status, 1); assert.doesNotMatch(result.stderr, /damaged sentinel|world\.dat/);
  assert.ok(!(await readdir(root)).includes('corrupt'));
  assert.equal(await readFile(join(archive, 'data', 'world.dat'), 'utf8'), 'damaged sentinel');
  assert.equal(await readFile(join(source, 'world.dat'), 'utf8'), 'synthetic world bytes');
  assert.equal(run().status, 1);
});
