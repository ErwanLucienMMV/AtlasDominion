import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rename, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, parse } from 'node:path';
import { BackupWorker } from '../apps/backup-worker/worker.mjs';
import { createArchive } from '../apps/backup-worker/archive.mjs';
import { pathsOverlap } from '../libs/filesystem-paths.mjs';

const instance = JSON.parse(await readFile(new URL('./fixtures/instance.json', import.meta.url)));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atlas-phase6-recovery-'));
  const source = join(root, 'source'), destination = join(root, 'archives'), lockDirectory = join(root, 'locks');
  for (const path of [source, destination, lockDirectory]) await mkdir(path);
  await writeFile(join(source, 'level.dat'), 'preserved world');
  const job = { instanceId: instance.id, source, destination, volumeName: 'world', containerPath: '/data', intervalSeconds: 60, keep: 1, minimumFreeBytes: 0, allowRetentionDeletion: false };
  const data = { Id: 'pinned', State: { Status: 'exited', ExitCode: 0 }, Mounts: [{ Type: 'volume', Name: 'world', Destination: '/data' }] };
  const events = [];
  const worker = new BackupWorker({ config: { lockDirectory, jobs: [job] }, instances: [instance], docker: { inspect: async () => ({ data }) }, report: e => events.push(e) });
  return { root, source, destination, lockDirectory, job, data, events, worker };
}

for (const restoredAt of [null, false, '', 'garbage', '2026-02-30T00:00:00.000Z', '2026-10-25']) {
  test(`retention preserves invalid restore timestamp ${JSON.stringify(restoredAt)}`, async () => {
    const f = await fixture(), archive = await f.worker.run(f.job);
    const marker = JSON.stringify({ instanceId: instance.id, restoredAt });
    await writeFile(join(archive, 'verified.json'), marker);
    await f.worker.run({ ...f.job, allowRetentionDeletion: true });
    assert.equal(await readFile(join(archive, 'verified.json'), 'utf8'), marker);
  });
}

test('invalid replacement marker prevents all pruning', async () => {
  const f = await fixture(), old = await f.worker.run(f.job), replacement = await f.worker.run(f.job);
  await writeFile(join(replacement, 'verified.json'), JSON.stringify({ instanceId: instance.id }));
  await assert.rejects(f.worker.retain(join(f.destination, instance.id), { ...f.job, allowRetentionDeletion: true }, basename(replacement)), /marker/);
  assert.ok(await lstat(old)); assert.ok(await lstat(replacement));
});

test('retention reserves a replacement slot with keep two after rollback', async () => {
  const f = await fixture(), root = join(f.destination, instance.id);
  for (const timestamp of ['9999999999998', '9999999999999']) {
    const archive = await f.worker.run(f.job);
    await rename(archive, join(root, `${timestamp}-00000000-0000-0000-0000-000000000000`));
  }
  const replacement = await f.worker.run({ ...f.job, keep: 2, allowRetentionDeletion: true });
  assert.deepEqual((await readdir(root)).sort(), [basename(replacement), '9999999999999-00000000-0000-0000-0000-000000000000'].sort());
});

test('success reporting happens after ownership release', async () => {
  const f = await fixture();
  f.worker.report = e => { assert.equal(existsSync(join(f.lockDirectory, instance.id)), false); f.events.push(e); };
  await f.worker.run(f.job); assert.equal(f.events[0].outcome, 'verified');
});

test('failed release reports failure and preserves both lock evidence and restore-tested bytes', async () => {
  const f = await fixture(); let calls = 0;
  f.worker.docker.inspect = async () => {
    if (++calls === 2) await writeFile(join(f.lockDirectory, instance.id, 'evidence'), 'preserve');
    return { data: f.data };
  };
  await assert.rejects(f.worker.run(f.job));
  assert.deepEqual(f.events, [{ instanceId: instance.id, outcome: 'failed' }]);
  assert.equal(await readFile(join(f.lockDirectory, instance.id, 'evidence'), 'utf8'), 'preserve');
  const root = join(f.destination, instance.id), [name] = await readdir(root);
  assert.equal(await readFile(join(root, name, 'data', 'level.dat'), 'utf8'), 'preserved world');
  assert.ok(JSON.parse(await readFile(join(root, name, 'verified.json'))).restoredAt);
});

test('native overlap comparisons handle roots, case aliases and sibling prefixes', async () => {
  const f = await fixture();
  assert.equal(pathsOverlap(parse(f.source).root, f.source), true);
  assert.equal(pathsOverlap(f.source, join(f.source, 'nested')), true);
  assert.equal(pathsOverlap(f.source, `${f.source}-sibling`), false);
  assert.equal(pathsOverlap(f.source, f.source.toUpperCase()), process.platform === 'win32');
  await assert.rejects(createArchive(f.source, join(f.source, 'archive'), instance.id), /overlaps/);
  if (process.platform === 'win32') await assert.rejects(createArchive(f.source, join(f.source.toUpperCase(), 'archive'), instance.id), /overlaps/);
});
