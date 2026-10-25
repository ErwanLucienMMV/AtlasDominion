import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstanceLock } from '../libs/instance-lock.mjs';
import { createArchive, restoreArchive, verifyArchive } from '../apps/backup-worker/archive.mjs';
import { BackupWorker, validateBackupConfig } from '../apps/backup-worker/worker.mjs';
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
