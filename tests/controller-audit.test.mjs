import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../apps/docker-controller/audit.mjs';
test('audit appends sanitized records and survives writer recreation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-audit-'));
  const event = { timestamp: '2026-10-24T22:00:00.000Z', instanceId: 'example', operation: 'start', outcome: 'accepted', error: null, authorization: 'PRIVATE_SENTINEL' };
  await new AuditLog(dir).append(event);
  await new AuditLog(dir).append({ ...event, outcome: 'completed' });
  assert.deepEqual(await readdir(dir), ['2026-10-24.jsonl']);
  const contents = await readFile(join(dir, '2026-10-24.jsonl'), 'utf8');
  assert.ok(!contents.includes('PRIVATE_SENTINEL'));
  const lines = contents.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map(e => e.outcome), ['accepted', 'completed']);
});
