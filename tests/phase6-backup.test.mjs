import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../libs/instance-lock.mjs';
import { createArchive, restoreArchive, verifyArchive } from '../apps/backup-worker/archive.mjs';
import { BackupWorker, validateBackupConfig } from '../apps/backup-worker/worker.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
const instance = JSON.parse(await readFile(new URL('./fixtures/instance.json', import.meta.url)));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atlas-phase6-'));
  const source = join(root, 'source'), destination = join(root, 'backups'), lockDirectory = join(root, 'locks');
  for (const p of [source, destination, lockDirectory]) await mkdir(p);
  await mkdir(join(source, 'empty')); await writeFile(join(source, 'level.dat'), 'Minecraft fixture world');
  const job = { instanceId: instance.id, source, destination, volumeName: 'world', containerPath: '/data', intervalSeconds: 60, keep: 1, minimumFreeBytes: 0, allowRetentionDeletion: false };
  const data = { Id: 'pinned', State: { Status: 'exited', ExitCode: 0 }, Mounts: [{ Type: 'volume', Name: 'world', Destination: '/data' }] };
  const events = [];
  const worker = new BackupWorker({ config: { lockDirectory, jobs: [job] }, instances: [instance], docker: { inspect: async () => ({ data }) }, report: e => events.push(e) });
  return { root, job, data, events, worker, lockDirectory };
}
test('archive restores world bytes and empty directories into a new destination', async () => {
  const f = await fixture(), archive = join(f.job.destination, 'archive');
  await createArchive(f.job.source, archive, instance.id);
  const restored = join(f.root, 'restored'); await restoreArchive(archive, restored, instance.id);
  assert.equal(await readFile(join(restored, 'level.dat'), 'utf8'), 'Minecraft fixture world');
  assert.deepEqual(await readdir(join(restored, 'empty')), []);
  await assert.rejects(restoreArchive(archive, restored, instance.id));
  await writeFile(join(archive, 'data', 'level.dat'), 'corrupt');
  await assert.rejects(verifyArchive(archive, instance.id), /integrity/);
});
test('worker holds shared lock throughout copying and records restore verification', async () => {
  const f = await fixture();
  f.worker.docker.inspect = async () => { await assert.rejects(acquireInstanceLock(f.lockDirectory, instance.id)); return { data: f.data }; };
  const archive = await f.worker.run(f.job);
  assert.equal(JSON.parse(await readFile(join(archive, 'verified.json'))).instanceId, instance.id);
  assert.equal(f.events[0].outcome, 'verified');
  const release = await acquireInstanceLock(f.lockDirectory, instance.id); await release();
});
test('running, crashed and wrong-volume instances fail without producing archives', async () => {
  for (const mutation of [d => d.State.Status = 'running', d => d.State.ExitCode = 137, d => d.Mounts = []]) {
    const f = await fixture(); mutation(f.data); await assert.rejects(f.worker.run(f.job));
    assert.equal(f.events[0].outcome, 'failed'); assert.deepEqual(await readdir(f.job.destination), []);
  }
});
test('persistent lock blocks another owner and is never expired automatically', async () => {
  const f = await fixture(), release = await acquireInstanceLock(f.lockDirectory, instance.id);
  await assert.rejects(f.worker.run(f.job)); await assert.rejects(acquireInstanceLock(f.lockDirectory, instance.id)); await release();
});
test('configuration rejects unknown instances, overlapping paths and invalid intervals', async () => {
  const f = await fixture();
  for (const change of [{ instanceId: 'unknown' }, { destination: f.job.source }, { intervalSeconds: 0 }, { keep: 0 }]) {
    assert.throws(() => validateBackupConfig({ lockDirectory: f.lockDirectory, jobs: [{ ...f.job, ...change }] }, [instance]));
  }
});
test('scheduler retries failures at interval and stops scheduling after shutdown', async () => {
  const f = await fixture(); let calls = 0; f.worker.run = async () => { calls++; throw new Error('offline'); };
  await f.worker.tick(1000); await f.worker.tick(2000); assert.equal(calls, 1);
  await f.worker.tick(61000); assert.equal(calls, 2); f.worker.stop(); await f.worker.tick(121000); assert.equal(calls, 2);
});
test('retention is opt-in and preserves the verified replacement', async () => {
  const f = await fixture(); await f.worker.run(f.job); await f.worker.run(f.job);
  const root = join(f.job.destination, instance.id); assert.equal((await readdir(root)).length, 2);
  await f.worker.run({ ...f.job, allowRetentionDeletion: true }); assert.equal((await readdir(root)).length, 1);
});
test('controller restart cannot start a world while the persistent backup lock exists', async () => {
  const f = await fixture();
  const actor = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: [] };
  const policy = { allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] };
  const entry = structuredClone(instance); Object.assign(entry.policy, policy);
  let starts = 0;
  const service = new ControllerService({ instances: [entry], policy, backupLockDirectory: f.lockDirectory,
    docker: { inspect: async () => ({ data: f.data, container: { start: async () => starts++ } }) },
    audit: { append: async () => {} }, capacity: { memoryMiB: 10000, cpuUnits: 8 }, timeoutMs: 5000, stopTimeoutSeconds: 1 });
  const release = await acquireInstanceLock(f.lockDirectory, instance.id); await service.reconcile();
  await assert.rejects(service.request(instance.id, 'start', { authorization: actor, idempotencyKey: 'test-backup-lock' .padEnd(16, 'x') }), /OPERATION_CONFLICT/);
  assert.equal(starts, 0); await release();
  const result = await service.request(instance.id, 'stop', { authorization: actor, idempotencyKey: 'test-release-lock' });
  assert.equal(result.operation.result, 'already_stopped');
  const again = await acquireInstanceLock(f.lockDirectory, instance.id); await again();
});
test('manifest traversal and wrong-instance archives are rejected before creating restore output', async () => {
  const f = await fixture(), archive = join(f.job.destination, 'archive');
  await createArchive(f.job.source, archive, instance.id);
  await assert.rejects(restoreArchive(archive, join(f.root, 'wrong-instance'), 'other-instance'));
  const manifest = JSON.parse(await readFile(join(archive, 'manifest.json')));
  manifest.entries[0].path = '../escape'; await writeFile(join(archive, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(restoreArchive(archive, join(f.root, 'unsafe'), instance.id), /manifest/);
  assert.equal((await readdir(f.root)).includes('unsafe'), false);
});
test('low disk headroom fails before creating an archive', async () => {
  const f = await fixture();
  await assert.rejects(createArchive(f.job.source, join(f.job.destination, 'no-space'), instance.id, Number.MAX_SAFE_INTEGER), /capacity/);
  assert.deepEqual(await readdir(f.job.destination), []);
});
test('unfamiliar compatible game instance reuses worker without a game-specific branch', async () => {
  const f = await fixture(), entry = structuredClone(instance); entry.gameType = 'fixture-unknown-game';
  const worker = new BackupWorker({ config: f.worker.config, instances: [entry], docker: f.worker.docker, report: () => {} });
  assert.ok(await worker.run(f.job));
});
