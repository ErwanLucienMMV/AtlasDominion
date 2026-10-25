// Requirements: docs/PHASE_9_VALIDATION.md, docs/RECOVERY.md, docs/PHASE_6_BACKUP.md.
// New disposable fixtures only. Preserve them as evidence; never prune existing data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive, restoreArchive, verifyArchive, inventory } from '../apps/backup-worker/archive.mjs';
import { AuditLog } from '../apps/docker-controller/audit.mjs';
import { Monitoring } from '../apps/docker-controller/monitoring.mjs';
import { acquireInstanceLock } from '../libs/instance-lock.mjs';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atlas-phase9-adversarial-'));
  const source = join(root, 'source'), archive = join(root, 'archive');
  await mkdir(source); await mkdir(join(source, 'empty')); await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested', 'world.bin'), Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
  await writeFile(join(source, 'zero.dat'), '');
  await createArchive(source, archive, 'approved');
  return { root, source, archive };
}

test('recovery preserves binary bytes, zero-byte files, empty directories and original archive', async () => {
  const f = await fixture(), before = await inventory(f.archive), output = join(f.root, 'restored');
  await restoreArchive(f.archive, output, 'approved');
  assert.deepEqual(await inventory(output), await inventory(f.source));
  assert.deepEqual(await inventory(f.archive), before); await verifyArchive(f.archive, 'approved');
});

test('RECOVERY: destination under archive data is refused before it corrupts the only backup', async () => {
  const f = await fixture(), before = await inventory(f.archive);
  await assert.rejects(restoreArchive(f.archive, join(f.archive, 'data', 'restored'), 'approved'));
  assert.deepEqual(await inventory(f.archive), before); await verifyArchive(f.archive, 'approved');
});

test('worker restoration scratch directory inside archive but outside data remains supported', async () => {
  const f = await fixture();
  await restoreArchive(f.archive, join(f.archive, 'restore-test'), 'approved');
  await verifyArchive(f.archive, 'approved');
});

for (const kind of ['directory', 'file']) test(`restore refuses existing ${kind} and preserves its sentinel bytes`, async () => {
  const f = await fixture(), output = join(f.root, 'existing');
  if (kind === 'directory') { await mkdir(output); await writeFile(join(output, 'sentinel'), 'existing data'); }
  else await writeFile(output, 'existing data');
  await assert.rejects(restoreArchive(f.archive, output, 'approved'));
  assert.equal(await readFile(kind === 'file' ? output : join(output, 'sentinel'), 'utf8'), 'existing data');
  await verifyArchive(f.archive, 'approved');
});

for (const path of ['../escape', '/absolute', 'C:/escape', 'nested/../../escape', 'nested\\escape', './escape', 'a//b', 'a/../b', 'a\0b']) {
  test(`manifest traversal ${JSON.stringify(path)} creates no destination or escaped file`, async () => {
    const f = await fixture(), file = join(f.archive, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8')); manifest.entries[0].path = path;
    const damaged = JSON.stringify(manifest); await writeFile(file, damaged);
    await assert.rejects(restoreArchive(f.archive, join(f.root, 'restored'), 'approved'));
    assert.deepEqual((await readdir(f.root)).sort(), ['archive', 'source']);
    assert.equal(await readFile(file, 'utf8'), damaged);
  });
}

for (const damage of ['truncate', 'same-size-bit-flip', 'extra-file', 'wrong-instance', 'duplicate-entry', 'null-entry']) {
  test(`restore rejects ${damage}, preserves evidence and creates no output`, async () => {
    const f = await fixture();
    const manifestPath = join(f.archive, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (damage === 'truncate') await writeFile(join(f.archive, 'data', 'nested', 'world.bin'), Buffer.alloc(2));
    if (damage === 'same-size-bit-flip') await writeFile(join(f.archive, 'data', 'nested', 'world.bin'), Buffer.alloc(256));
    if (damage === 'extra-file') await writeFile(join(f.archive, 'data', 'extra'), 'evidence');
    if (damage === 'wrong-instance') manifest.instanceId = 'another';
    if (damage === 'duplicate-entry') manifest.entries.push(manifest.entries[0]);
    if (damage === 'null-entry') manifest.entries.push(null);
    await writeFile(manifestPath, JSON.stringify(manifest));
    const before = await inventory(f.archive);
    await assert.rejects(restoreArchive(f.archive, join(f.root, 'restored'), 'approved'));
    assert.deepEqual(await inventory(f.archive), before);
    assert.deepEqual((await readdir(f.root)).sort(), ['archive', 'source']);
  });
}

test('hardlinked archive payload is refused while both links and original evidence survive', async () => {
  const f = await fixture(), target = join(f.archive, 'data', 'nested', 'world.bin');
  await link(target, join(f.root, 'hardlink'));
  await assert.rejects(restoreArchive(f.archive, join(f.root, 'restored'), 'approved'), /Links/);
  assert.deepEqual(await readFile(target), await readFile(join(f.root, 'hardlink')));
});

test('two simultaneous restores to the same absent destination have one winner without byte loss', async () => {
  const f = await fixture(), output = join(f.root, 'restored');
  const results = await Promise.allSettled([restoreArchive(f.archive, output, 'approved'), restoreArchive(f.archive, output, 'approved')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.deepEqual(await inventory(output), await inventory(f.source)); await verifyArchive(f.archive, 'approved');
});

test('100 competing persistent lock owners admit exactly one, and release is idempotent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-phase9-ownership-'));
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => acquireInstanceLock(root, 'approved')));
  const owners = results.filter(r => r.status === 'fulfilled');
  assert.equal(owners.length, 1); assert.deepEqual(await readdir(root), ['approved']);
  await owners[0].value(); await owners[0].value(); assert.deepEqual(await readdir(root), []);
  const release = await acquireInstanceLock(root, 'approved'); await release();
});

test('REBOOT: rollback across UTC midnight does not resurrect superseded desired intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-phase9-clock-')), audit = new AuditLog(root);
  const common = { instanceId: 'approved', outcome: 'accepted', error: null };
  // A later request after NTP correction is appended to the previous day's file.
  await audit.append({ ...common, timestamp: '2026-10-26T00:00:02.000Z', operation: 'start' });
  await audit.append({ ...common, timestamp: '2026-10-25T23:59:59.000Z', operation: 'stop' });
  const before = await inventory(root);
  const desired = await new AuditLog(root).desiredStates([{ id: 'approved' }]);
  assert.deepEqual(await inventory(root), before);
  assert.equal(desired.get('approved'), 'wanted_stopped', 'last durably accepted intent must survive restart');
});

test('MONITORING: midnight rollback and reboot cannot suppress a later unexpected crash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-phase9-suppressed-crash-')), audit = new AuditLog(root);
  const common = { instanceId: 'approved', outcome: 'accepted', error: null };
  await audit.append({ ...common, timestamp: '2026-10-26T00:00:02.000Z', operation: 'stop' });
  await audit.append({ ...common, timestamp: '2026-10-25T23:59:59.000Z', operation: 'start' });
  const desired = await new AuditLog(root).desiredStates([{ id: 'approved' }]), monitoring = new Monitoring();
  monitoring.observe('approved', 'running', desired.get('approved'));
  monitoring.observe('approved', 'exited', desired.get('approved'));
  assert.equal(monitoring.exits.get('approved'), 1, 'latest accepted start must make a crash visible after restart');
});
