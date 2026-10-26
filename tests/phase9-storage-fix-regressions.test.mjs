import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../apps/docker-controller/audit.mjs';
import { verifyArchive, restoreArchive } from '../apps/backup-worker/archive.mjs';

const event = { timestamp: '2026-10-26T12:00:00.000Z', instanceId: 'approved', operation: 'start', outcome: 'accepted', error: null };

for (const ending of ['\n', '\r\n', '\r']) test(`append preserves opaque delimited operator metadata ${JSON.stringify(ending)} without trusting it as intent`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-audit-legacy-metadata-'));
  const file = join(root, '2026-10-26.jsonl');
  const original = `${JSON.stringify({ preserved: 'existing operator record' })}${ending}`;
  await writeFile(file, original);
  const audit = new AuditLog(root);
  await audit.append(event);
  assert.equal(await readFile(file, 'utf8'), `${original}${JSON.stringify(event)}\n`);
  await assert.rejects(new AuditLog(root).desiredStates([{ id: 'approved' }]));
});

for (const original of [JSON.stringify({ preserved: 'existing operator record' }), `${JSON.stringify({ outcome: 'accepted', preserved: 'incomplete audit' })}\n`]) {
  test(`append refuses ambiguous or audit-shaped metadata ${JSON.stringify(original)}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-audit-metadata-refusal-'));
    const file = join(root, '2026-10-26.jsonl');
    await writeFile(file, original);
    await assert.rejects(new AuditLog(root).append(event));
    assert.equal(await readFile(file, 'utf8'), original);
  });
}

test('append separates a long UTF-8 final record without rewriting its bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-audit-tail-boundary-'));
  const file = join(root, '2026-10-26.jsonl');
  const original = Buffer.from(`${JSON.stringify(event)}\n${JSON.stringify({ ...event, legacy: '世界'.repeat(3000) })}`);
  await writeFile(file, original);
  const audit = new AuditLog(root);
  await Promise.all(['stop', 'start', 'stop'].map(operation => audit.append({ ...event, operation })));
  const bytes = await readFile(file);
  assert.deepEqual(bytes.subarray(0, original.length), original);
  assert.equal(bytes.subarray(original.length).toString(), `\n${['stop', 'start', 'stop'].map(operation => JSON.stringify({ ...event, operation })).join('\n')}\n`);
  assert.equal((await new AuditLog(root).desiredStates([{ id: 'approved' }])).get('approved'), 'wanted_stopped');
});

for (const tail of ['{', '{}', JSON.stringify(event).slice(0, -1), '\0']) for (const ending of ['', '\n']) {
  test(`append refuses damaged audit tail ${JSON.stringify(tail + ending)} without changing evidence`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'atlas-audit-tail-refusal-'));
    const file = join(root, '2026-10-26.jsonl');
    const original = Buffer.from(`${JSON.stringify(event)}\n${tail}${ending}`);
    await writeFile(file, original);
    const audit = new AuditLog(root);
    await assert.rejects(audit.append({ ...event, operation: 'stop' }));
    // A recovered queue must still refuse the same damaged bytes on retry.
    await assert.rejects(audit.append(event));
    assert.deepEqual(await readFile(file), original);
    await assert.rejects(audit.desiredStates([{ id: 'approved' }]));
  });
}

test('manifest directory is rejected before restore creates output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-manifest-type-'));
  const archive = join(root, 'archive'), output = join(root, 'restored');
  await mkdir(archive);
  await mkdir(join(archive, 'manifest.json'));
  await assert.rejects(verifyArchive(archive, 'approved'), /Unsafe archive manifest/);
  await assert.rejects(restoreArchive(archive, output, 'approved'), /Unsafe archive manifest/);
  assert.deepEqual(await readdir(root), ['archive']);
});
