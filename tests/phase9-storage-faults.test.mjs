// Requirements: PHASE_9_HARDENING.md, PHASE_2_CONTROLLER.md, PHASE_6_BACKUP.md,
// RECOVERY.md. New disposable files only; fixtures are retained as evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, link, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLog } from '../apps/docker-controller/audit.mjs';
import { createArchive, restoreArchive, verifyArchive, inventory } from '../apps/backup-worker/archive.mjs';
import { acquireInstanceLock } from '../libs/instance-lock.mjs';

const event = { timestamp: '2026-10-26T12:00:00.000Z', instanceId: 'approved', operation: 'start', outcome: 'accepted', error: null };
const fresh = prefix => mkdtemp(join(tmpdir(), `atlas-p9-${prefix}-`));
async function archiveFixture() {
  const root = await fresh('storage'), source = join(root, 'source'), archive = join(root, 'archive');
  await mkdir(source); await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested', 'world.bin'), Buffer.from([0, 255, 10, 13, 0, 128]));
  await createArchive(source, archive, 'approved');
  return { root, source, archive };
}

for (const operation of ['start', 'stop']) test(`reboot and append preserve valid ${operation} history without a final newline`, async () => {
  const root = await fresh('audit-tail'), file = join(root, '2026-10-26.jsonl');
  const oldBytes = JSON.stringify({ ...event, operation });
  await writeFile(file, oldBytes);
  const audit = new AuditLog(root);
  assert.equal((await audit.desiredStates([{ id: 'approved' }])).get('approved'), operation === 'start' ? 'wanted_running' : 'wanted_stopped');
  await audit.append({ ...event, operation: operation === 'start' ? 'stop' : 'start' });
  assert.ok((await readFile(file, 'utf8')).startsWith(oldBytes), 'existing history must never be rewritten');
  const recovered = await new AuditLog(root).desiredStates([{ id: 'approved' }]);
  assert.equal(recovered.get('approved'), operation === 'start' ? 'wanted_stopped' : 'wanted_running');
});

for (const ending of ['\n', '\r\n', '\r']) test(`append preserves replay with legacy line ending ${JSON.stringify(ending)}`, async () => {
  const root = await fresh('audit-line'), file = join(root, '2026-10-26.jsonl');
  const oldBytes = JSON.stringify(event) + ending; await writeFile(file, oldBytes);
  await new AuditLog(root).append({ ...event, operation: 'stop' });
  assert.ok((await readFile(file, 'utf8')).startsWith(oldBytes));
  assert.equal((await new AuditLog(root).desiredStates([{ id: 'approved' }])).get('approved'), 'wanted_stopped');
});

for (const damage of ['{', JSON.stringify(event).slice(0, -1), JSON.stringify(event) + '\n\0', JSON.stringify(event) + '\n{}']) {
  test(`damaged audit tail ${JSON.stringify(damage.slice(-14))} fails closed and preserves bytes`, async () => {
    const root = await fresh('audit-damaged'), file = join(root, '2026-10-26.jsonl'); await writeFile(file, damage);
    await assert.rejects(new AuditLog(root).desiredStates([{ id: 'approved' }]));
    assert.equal(await readFile(file, 'utf8'), damage);
  });
}

test('concurrent append order and midnight rollback survive a new reader', async () => {
  const root = await fresh('audit-concurrent'), audit = new AuditLog(root);
  const operations = Array.from({ length: 64 }, (_, i) => i % 2 ? 'stop' : 'start');
  await Promise.all(operations.map((operation, i) => audit.append({ ...event, operation,
    timestamp: i % 2 ? '2026-10-25T23:59:59.000Z' : event.timestamp })));
  assert.deepEqual(await readdir(root), ['2026-10-26.jsonl']);
  const records = (await readFile(join(root, '2026-10-26.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records.map(r => r.operation), operations);
  assert.equal((await new AuditLog(root).desiredStates([{ id: 'approved' }])).get('approved'), 'wanted_stopped');
});

for (const method of ['verify', 'restore']) test(`${method} rejects hardlinked archive manifest metadata`, async () => {
  const f = await archiveFixture(), manifest = join(f.archive, 'manifest.json'), alias = join(f.root, 'manifest-alias');
  await link(manifest, alias);
  const before = await readFile(manifest), output = join(f.root, 'restored');
  const result = method === 'verify' ? verifyArchive(f.archive, 'approved') : restoreArchive(f.archive, output, 'approved');
  let rejected = false;
  try { await result; } catch { rejected = true; }
  assert.deepEqual(await readFile(manifest), before);
  assert.deepEqual(await readFile(alias), before);
  assert.equal(rejected, true, 'metadata links must fail the documented no-links archive policy');
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

for (const location of ['root', 'data', 'nested']) test(`directory link at archive ${location} cannot escape verification`, async () => {
  const f = await archiveFixture(), alias = join(f.root, 'alias');
  const target = location === 'root' ? f.archive : join(f.archive, 'data', ...(location === 'nested' ? ['nested'] : []));
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  if (location === 'root') await assert.rejects(verifyArchive(alias, 'approved'));
  else {
    const destination = join(f.archive, 'data', 'escape');
    await symlink(target, destination, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(verifyArchive(f.archive, 'approved'));
  }
  assert.deepEqual(await readFile(join(f.source, 'nested', 'world.bin')), Buffer.from([0, 255, 10, 13, 0, 128]));
});

test('deeply nested source restores completely without flattening empty directories', async () => {
  const root = await fresh('deep-tree'), source = join(root, 'source'), archive = join(root, 'archive'), output = join(root, 'restored');
  await mkdir(source);
  let path = source;
  for (let i = 0; i < 32; i++) { path = join(path, 'd'); await mkdir(path); }
  await mkdir(join(path, 'empty')); await writeFile(join(path, 'world'), 'last level');
  await createArchive(source, archive, 'approved'); await restoreArchive(archive, output, 'approved');
  assert.deepEqual(await inventory(output), await inventory(source));
});

test('concurrent release calls remain idempotent for one persistent owner', async () => {
  const root = await fresh('release'), release = await acquireInstanceLock(root, 'approved');
  const results = await Promise.allSettled(Array.from({ length: 16 }, () => release()));
  assert.deepEqual(await readdir(root), []);
  assert.equal(results.filter(r => r.status === 'rejected').length, 0);
  const next = await acquireInstanceLock(root, 'approved'); await next();
});

test('an owner cannot release a lock directory containing operator evidence', async () => {
  const root = await fresh('lock-evidence'), release = await acquireInstanceLock(root, 'approved');
  await writeFile(join(root, 'approved', 'evidence'), 'preserve ownership');
  await assert.rejects(release());
  assert.equal(await readFile(join(root, 'approved', 'evidence'), 'utf8'), 'preserve ownership');
  await assert.rejects(acquireInstanceLock(root, 'approved'));
});
