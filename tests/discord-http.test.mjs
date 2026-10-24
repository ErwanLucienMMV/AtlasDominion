import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createDiscordApplication } from '../apps/discord-api/http.mjs';
import { DiscordService } from '../apps/discord-api/service.mjs';
import { command, serverCommand } from '../apps/discord-api/commands.mjs';

const keys = generateKeyPairSync('ed25519');
const guild = '123456789012345678', user = '223456789012345678', applicationId = '323456789012345678';
const config = { publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), applicationId,
  policy: { allowedDiscordGuilds: [guild], allowedDiscordUsers: [user], allowedDiscordRoles: [] } };
let sequence = 400000000000000000n;
function interaction(action = 'status', value = 'test-instance') {
  return { id: String(sequence++), application_id: applicationId, token: 'test-token', type: 2, guild_id: guild,
    member: { user: { id: user }, roles: [] }, data: { name: 'server', options: [{ name: action, type: 1,
      options: action === 'list' ? [] : [{ name: 'instance', type: 3, value }] }] } };
}
async function setup(t, controller = {}, options = {}) {
  const deliveries = [];
  const service = new DiscordService({ controller, applicationId, pollMs: 1, ...options,
    fetchImpl: async (url, init) => { deliveries.push({ url, ...JSON.parse(init.body) }); return new Response('{}'); } });
  const app = await createDiscordApplication(service, config); await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const base = await app.getUrl();
  const post = async (payload, overrides = {}) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
    return fetch(`${base}/discord/interactions`, { method: 'POST', headers: { 'content-type': 'application/json',
      'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex'), ...overrides }, body });
  };
  const done = async (count = 1) => {
    for (let i = 0; i < 200 && deliveries.length < count; i++) await delay(5);
    assert.equal(deliveries.length, count); return deliveries.at(-1);
  };
  return { post, deliveries, done, service };
}
test('real Nest ingress verifies signed PING, rejects invalid bytes, malformed JSON and oversized payloads', async t => {
  const { post } = await setup(t);
  assert.deepEqual(await (await post({ type: 1 })).json(), { type: 1 });
  assert.equal((await post({ type: 1 }, { 'x-signature-ed25519': '0'.repeat(128) })).status, 401);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post('x'.repeat(65537))).status, 400);
});
test('unauthorized guild, user, DMs and wrong application never reach controller', async t => {
  let calls = 0; const { post } = await setup(t, { status: async () => { calls++; } });
  for (const patch of [{ guild_id: '523456789012345678' }, { member: { user: { id: '623456789012345678' }, roles: [] } }, { guild_id: undefined, member: undefined }]) {
    const result = await (await post({ ...interaction(), ...patch })).json(); assert.equal(result.type, 4); assert.equal(result.data.flags, 64);
  }
  assert.equal((await post({ ...interaction(), application_id: guild })).status, 400); assert.equal(calls, 0);
});
test('deferred acknowledgement arrives before a stalled controller and duplicate delivery does no new work', async t => {
  let release, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const { post, done } = await setup(t, { status: async () => { calls++; await waiting; return { instanceId: 'test-instance', docker: 'running', readiness: 'unverified' }; } });
  const payload = interaction(), start = performance.now();
  const response = await (await post(payload)).json();
  assert.equal(response.type, 5); assert.equal(response.data.flags, 64); assert.ok(performance.now() - start < 2500);
  assert.equal((await (await post(payload)).json()).type, 5);
  release(); const delivery = await done(); assert.equal(calls, 1); assert.match(delivery.content, /unverified/); assert.deepEqual(delivery.allowed_mentions, { parse: [] });
});
test('unknown instance and controller outage produce sanitized deferred errors', async t => {
  const { post, done, service } = await setup(t, { status: async () => { throw Object.assign(new Error('private-secret'), { code: 'UNKNOWN_INSTANCE' }); } });
  assert.equal((await (await post(interaction())).json()).type, 5);
  assert.match((await done()).content, /Unknown or inaccessible/);
  service.controller.status = async () => { throw new Error('private-secret'); };
  await post(interaction()); const delivery = await done(2); assert.match(delivery.content, /unavailable/); assert.doesNotMatch(delivery.content, /private-secret/);
});
test('list pagination uses live registry, preserves cursor, and emits no mentions', async t => {
  let count = 0;
  const { post, done } = await setup(t, { list: async (actor, cursor, signal, limit) => {
    assert.equal(limit, 3); assert.equal(actor.userId, user);
    return { items: [{ instanceId: `dynamic-${++count}`, displayName: '@everyone', docker: 'missing', readiness: 'unknown' }], nextCursor: cursor ? null : 'Mw' };
  } });
  await post(interaction('list')); const first = await done(); assert.match(first.content, /dynamic-1/); assert.match(first.content, /cursor:Mw/);
  const next = interaction('list'); next.data.options[0].options = [{ name: 'cursor', type: 3, value: 'Mw' }];
  await post(next); const second = await done(2); assert.match(second.content, /dynamic-2/); assert.doesNotMatch(second.content, /Next page/);
  assert.deepEqual(second.allowed_mentions, { parse: [] });
});
test('start and stop poll asynchronous operations without claiming readiness', async t => {
  const actions = []; const { post, done } = await setup(t, {
    operate: async (id, action, actor, key) => { actions.push(action); assert.match(key, /^[0-9]+$/); return { operationId: 'op', instanceId: id, action, state: 'queued' }; },
    operation: async () => ({ operationId: 'op', instanceId: 'test-instance', action: actions.at(-1), state: 'completed', result: 'changed' })
  });
  for (const [i, action] of ['start', 'stop'].entries()) {
    await post(interaction(action)); const result = await done(i + 1); assert.match(result.content, /completed/); assert.match(result.content, /does not establish game readiness/);
  }
  assert.deepEqual(actions, ['start', 'stop']);
});
test('autocomplete traverses registry pages, caps choices at 25 and isolates outages', async t => {
  let calls = 0;
  const { post, service } = await setup(t, { list: async (actor, cursor, signal) => {
    assert.ok(signal); calls++;
    return { items: Array.from({ length: 25 }, (_, i) => ({ instanceId: `new-game-${cursor ? i + 25 : i}`, displayName: cursor ? 'Target game' : 'Other game' })), nextCursor: cursor ? null : 'MjU' };
  } });
  const payload = interaction('status', 'target'); payload.type = 4; payload.data.options[0].options[0].focused = true;
  const result = await (await post(payload)).json(); assert.equal(result.type, 8); assert.equal(result.data.choices.length, 25); assert.equal(calls, 2);
  assert.equal(result.data.choices[0].value, 'new-game-25');
  service.controller.list = async () => { throw new Error('private-secret'); };
  assert.deepEqual((await (await post(payload)).json()).data.choices, []);
});
test('commands reject arbitrary options, paths and provisioning while registration stays game independent', () => {
  assert.deepEqual(serverCommand.options.map(o => o.name), ['list', 'status', 'start', 'stop']);
  for (const value of ['../container', '/exec', 'UPPER', 'x'.repeat(64)]) assert.throws(() => command(interaction('start', value).data));
  assert.throws(() => command(interaction('create').data));
  const payload = interaction(); payload.data.options[0].options.push({ name: 'command', value: 'exec', type: 3 }); assert.throws(() => command(payload.data));
});
test('bounded pending jobs and per-user rate limit deny work before controller access', async t => {
  let calls = 0;
  const { post, service } = await setup(t, { status: async () => { calls++; } }, { maxPending: 0 });
  assert.match((await (await post(interaction())).json()).data.content, /capacity/);
  for (let i = 0; i < 19; i++) await post(interaction());
  assert.match((await (await post(interaction())).json()).data.content, /limit/);
  assert.equal(service.pending.size, 0); assert.equal(calls, 0);
});
test('pending operations report pending at completion deadline and failed operations retain error', async t => {
  const { post, done, service } = await setup(t, { operate: async () => ({ operationId: 'op', instanceId: 'test-instance', action: 'start', state: 'queued' }) }, { completionMs: 0 });
  await post(interaction('start')); assert.match((await done()).content, /Still pending/);
  service.controller.operate = async () => ({ operationId: 'op', instanceId: 'test-instance', action: 'start', state: 'failed', error: 'DOCKER_UNAVAILABLE' });
  await post(interaction('start')); const result = await done(2); assert.match(result.content, /failed/); assert.match(result.content, /DOCKER_UNAVAILABLE/);
});
test('failed Discord delivery does not repeat lifecycle work or retain a pending slot', async () => {
  let operations = 0;
  const service = new DiscordService({ applicationId, controller: { operate: async () => { operations++; return { state: 'completed' }; } },
    fetchImpl: async () => { throw new Error('sensitive-url'); } });
  const payload = interaction('start'); assert.equal(service.reserve(payload), 'accepted');
  await service.complete(payload, { action: 'start', instance: 'test-instance' }, { guildId: guild, userId: user, roleIds: [] });
  assert.equal(service.pending.size, 0); assert.equal(operations, 1); assert.equal(service.reserve(payload), 'duplicate');
});
