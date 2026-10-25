import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AuditLog } from '../apps/docker-controller/audit.mjs';
import { verifyIdentity } from '../apps/docker-controller/docker.mjs';
import { createArchive, restoreArchive, verifyArchive } from '../apps/backup-worker/archive.mjs';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { createDiscordApplication } from '../apps/discord-api/http.mjs';
import { harness, actor, policy, request, deferred, until, manifest, inspection } from './phase2-harness.mjs';

for (const source of ['/srv/game-data', '/var/lib/games/world', '/var/lib/docker-other']) test(`ordinary game bind ${source} stays supported`, () => {
  const entry = manifest(), data = inspection(entry);
  data.Config.User = '1000:1000'; data.Mounts = [{ Type: 'bind', Source: source, Destination: '/data' }];
  assert.doesNotThrow(() => verifyIdentity(entry, data, ['127.0.0.1']));
});

test('archive payload overlap is rejected after path normalization without changing backup bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-p9-overlap-')), source = join(root, 'source'), archive = join(root, 'archive');
  await mkdir(source); await writeFile(join(source, 'world.dat'), 'preserved world');
  await createArchive(source, archive, 'approved');
  for (const destination of [join(archive, 'data'), join(archive, 'restore-test', '..', 'data', 'nested'), archive, root])
    await assert.rejects(restoreArchive(archive, destination, 'approved'), /overlaps/);
  assert.deepEqual((await readdir(archive)).sort(), ['data', 'manifest.json']);
  await verifyArchive(archive, 'approved');
  await restoreArchive(archive, join(archive, 'restore-test'), 'approved');
  assert.equal(await readFile(join(archive, 'restore-test', 'world.dat'), 'utf8'), 'preserved world');
  await verifyArchive(archive, 'approved');
});

test('recreated audit writers append rollback records after legacy history without new fields or rewriting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atlas-p9-order-'));
  const event = { timestamp: '2026-10-26T00:00:02.000Z', instanceId: 'approved', operation: 'start', outcome: 'accepted', error: null };
  const filename = join(root, '2026-10-26.jsonl'), legacy = JSON.stringify(event) + '\n';
  await writeFile(filename, legacy);
  await new AuditLog(root).append({ ...event, timestamp: '2026-10-25T23:59:59.000Z', operation: 'stop' });
  assert.deepEqual(await readdir(root), ['2026-10-26.jsonl']);
  const bytes = await readFile(filename, 'utf8'); assert.ok(bytes.startsWith(legacy));
  const records = bytes.trim().split('\n').map(JSON.parse);
  assert.equal(records[1].timestamp, '2026-10-25T23:59:59.000Z');
  assert.deepEqual(Object.keys(records[1]).sort(), Object.keys(event).sort());
  assert.equal((await new AuditLog(root).desiredStates([{ id: 'approved' }])).get('approved'), 'wanted_stopped');
  await new AuditLog(root).append({ ...event, timestamp: '2026-10-27T00:00:00.000Z' });
  assert.deepEqual((await readdir(root)).sort(), ['2026-10-26.jsonl', '2026-10-27.jsonl']);
  assert.equal((await new AuditLog(root).desiredStates([{ id: 'approved' }])).get('approved'), 'wanted_running');
  assert.equal(await readFile(filename, 'utf8'), bytes);
});

for (const outcome of ['completed', 'failed']) test(`stalled ${outcome} audit retains ownership and persists timeout after the late write`, async () => {
  const h = harness({ timeoutMs: 1050 }); await h.service.reconcile();
  const gate = deferred(), entered = deferred();
  if (outcome === 'failed') h.hooks.start = async () => { throw new Error('private Engine message'); };
  h.hooks.audit = async event => { if (event.outcome === outcome) { entered.resolve(); await gate.promise; } };
  const result = await h.service.request('edge-0', 'start', request()); await entered.promise;
  try {
    await until(() => h.service.operation(result.operation.operationId, actor).state === 'timed_out');
    assert.equal(h.service.operation(result.operation.operationId, actor).result, null);
    assert.ok(h.service.locks.has('edge-0')); assert.equal(h.service.failedAudits.size, 1);
    await h.service.reconcile();
    assert.equal(h.service.ready, false); assert.equal(h.service.failedAudits.size, 1);
    assert.deepEqual(h.events.map(e => e.outcome), ['accepted']);
  } finally { gate.resolve(); await until(() => h.service.locks.size === 0 && h.service.failedAudits.size === 0); }
  assert.deepEqual(h.events.map(e => e.outcome), ['accepted', outcome, 'timed_out']);
  assert.equal(h.service.operation(result.operation.operationId, actor).state, 'timed_out');
  assert.equal(h.service.operation(result.operation.operationId, actor).error, 'TIMEOUT');
  assert.equal(h.service.ready, true);
  assert.equal((await h.service.request('edge-0', 'start', request())).operation.state, 'timed_out');
  assert.doesNotMatch(JSON.stringify(h.events), /private Engine message/);
  assert.equal(h.service.monitoring.outcomes.get('edge-0:start:timed_out'), 1);
  const metrics = h.service.monitoring.render(h.service);
  assert.match(metrics, /atlas_operations_total\{instance="edge-0",action="start",outcome="timed_out"\} 1/);
});

const keys = generateKeyPairSync('ed25519');
const config = { applicationId: '333333333333333333', policy: policy(), publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') };

test('signed PING, deferred command, authorization reply and autocomplete all use HTTP 200', async t => {
  const calls = [];
  const app = await createDiscordApplication({ reserve: () => 'accepted', complete: async () => { calls.push('complete'); }, autocomplete: async () => [] }, config);
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const payload = { id: '444444444444444444', type: 2, token: 'synthetic-token', application_id: config.applicationId,
    guild_id: actor.guildId, member: { user: { id: actor.userId }, roles: [] },
    data: { name: 'server', options: [{ name: 'status', type: 1, options: [{ name: 'instance', type: 3, value: 'edge-0' }] }] } };
  const autocomplete = structuredClone(payload); autocomplete.type = 4; autocomplete.data.options[0].options[0].focused = true;
  for (const [value, type] of [[{ type: 1 }, 1], [payload, 5], [{ ...payload, guild_id: '555555555555555555' }, 4], [autocomplete, 8]]) {
    const body = JSON.stringify(value), timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`${await app.getUrl()}/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex') }, body });
    assert.equal(response.status, 200); assert.equal((await response.json()).type, type);
  }
  await until(() => calls.length === 1);
});

for (const target of ['controller', 'discord']) test(`${target} closes incomplete headers within the five-second deadline plus scheduling allowance`, { timeout: 9000 }, async t => {
  const app = target === 'controller' ? await createApplication({}, ['s'.repeat(64)]) : await createDiscordApplication({}, config);
  assert.equal(app.getHttpServer().connectionsCheckingInterval, 250);
  await app.listen(0, '127.0.0.1');
  t.after(async () => { app.getHttpServer().closeAllConnections(); await app.close(); });
  const url = new URL(await app.getUrl()), socket = connect({ host: url.hostname, port: Number(url.port) });
  t.after(() => socket.destroy()); socket.on('error', () => {}); socket.resume();
  const closed = new Promise(resolve => socket.once('close', () => resolve(true)));
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write('POST /discord/interactions HTTP/1.1\r\nHost: localhost\r\nX-Partial:');
  let timer;
  try { assert.equal(await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve(false), 7000); })]), true); }
  finally { clearTimeout(timer); socket.destroy(); }
});
