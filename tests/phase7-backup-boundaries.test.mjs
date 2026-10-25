import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackupWorker, validateBackupConfig } from '../apps/backup-worker/worker.mjs';
import { createArchive, restoreArchive } from '../apps/backup-worker/archive.mjs';
import { games, fixture, access } from './phase7-harness.mjs';

async function setup(game, mutate = () => {}) {
  const { entry, data } = fixture(game);
  // Retain isolated evidence; never touch Docker or real game volumes.
  const root = await mkdtemp(join(tmpdir(), `atlas-phase7-boundary-${game}-`));
  const source = join(root, 'source'), destination = join(root, 'archives'), lockDirectory = join(root, 'locks');
  await Promise.all([mkdir(source), mkdir(destination), mkdir(lockDirectory)]);
  await writeFile(join(source, 'world.save'), Buffer.from([0, 255, 13, 10, 128]));
  const job = { instanceId: entry.id, source, destination, volumeName: `${game}-world`,
    containerPath: data.Mounts[0].Destination, intervalSeconds: 60, keep: 2,
    minimumFreeBytes: 0, allowRetentionDeletion: false };
  let count = 0;
  const { docker } = access(data, () => mutate(data, ++count));
  const reports = [], config = { lockDirectory, jobs: [job] };
  const worker = new BackupWorker({ config, instances: [entry], docker, report: e => reports.push(e) });
  return { entry, data, root, source, destination, job, worker, reports, config };
}
const badStates = [
  { Status: 'running', ExitCode: 0 }, { Status: 'paused', ExitCode: 0 },
  { Status: 'restarting', ExitCode: 0 }, { Status: 'created', ExitCode: 0 },
  { Status: 'removing', ExitCode: 0 }, { Status: 'dead', ExitCode: 0 },
  { Status: 'exited', ExitCode: 137 }, { Status: 'exited', ExitCode: 143 },
  { Status: 'exited', ExitCode: 0, OOMKilled: true }, { Status: 'exited' }
];
for (const game of games) {
  for (const state of badStates) test(`${game}: backup refuses ${JSON.stringify(state)} without writing archives`, async () => {
    const h = await setup(game); h.data.State = state;
    await assert.rejects(h.worker.run(h.job), /Clean stopped/);
    assert.deepEqual(await readdir(h.destination), []);
    assert.deepEqual(await readdir(h.config.lockDirectory), []);
    assert.equal(h.reports.at(-1).outcome, 'failed');
  });
  for (const field of ['Name', 'Destination', 'Type']) test(`${game}: wrong persistent mount ${field} cannot certify backup`, async () => {
    const h = await setup(game); h.data.Mounts[0][field] = 'wrong';
    await assert.rejects(h.worker.run(h.job), /Backup volume mismatch/);
    assert.deepEqual(await readdir(h.destination), []);
  });
  for (const change of ['running', 'replacement', 'mount']) test(`${game}: ${change} drift during archive prevents verified success`, async () => {
    const h = await setup(game, (data, count) => {
      if (count !== 2) return;
      if (change === 'running') data.State.Status = 'running';
      if (change === 'replacement') data.Id = 'replacement-id';
      if (change === 'mount') data.Mounts[0].Name = 'different-world';
    });
    await assert.rejects(h.worker.run(h.job));
    assert.equal(h.reports.at(-1).outcome, 'failed');
    assert.ok(!h.reports.some(r => r.outcome === 'verified'));
    assert.deepEqual(await readdir(h.config.lockDirectory), []);
  });
  test(`${game}: second instance cannot restore this world's archive`, async () => {
    const h = await setup(game), archive = await h.worker.run(h.job);
    await assert.rejects(restoreArchive(archive, join(h.root, 'wrong-restore'), `${h.entry.id}-other`), /Invalid manifest/);
    await restoreArchive(archive, join(h.root, 'correct-restore'), h.entry.id);
    assert.deepEqual(await readFile(join(h.root, 'correct-restore', 'world.save')), Buffer.from([0, 255, 13, 10, 128]));
  });
  test(`${game}: archive corruption cannot overwrite existing restored saves`, async () => {
    const h = await setup(game), archive = await h.worker.run(h.job), restored = join(h.root, 'restore');
    await restoreArchive(archive, restored, h.entry.id);
    await writeFile(join(archive, 'data', 'world.save'), 'corrupted synthetic archive');
    await assert.rejects(restoreArchive(archive, join(h.root, 'bad-restore'), h.entry.id), /integrity/);
    await assert.rejects(restoreArchive(archive, restored, h.entry.id));
    assert.deepEqual(await readFile(join(restored, 'world.save')), Buffer.from([0, 255, 13, 10, 128]));
  });
  test(`${game}: hardlinked installation files fail closed without changing source`, async () => {
    const h = await setup(game);
    await link(join(h.source, 'world.save'), join(h.source, 'installation-link'));
    await assert.rejects(createArchive(h.source, join(h.destination, 'linked-archive'), h.entry.id), /Links and special files/);
    assert.deepEqual(await readFile(join(h.source, 'world.save')), Buffer.from([0, 255, 13, 10, 128]));
  });
  test(`${game}: worker rejects parent destination that overlaps another game's archive`, async () => {
    const h = await setup(game), other = fixture(games.find(g => g !== game)).entry;
    const job2 = { ...h.job, instanceId: other.id, source: join(h.root, 'other-source'), destination: join(h.destination, 'other') };
    assert.throws(() => validateBackupConfig({ ...h.config, jobs: [h.job, job2] }, [h.entry, other]), /Overlapping/);
  });
}
