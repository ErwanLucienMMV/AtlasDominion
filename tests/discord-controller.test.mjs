import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { ControllerClient } from '../apps/discord-api/controller.mjs';
import { DiscordService } from '../apps/discord-api/service.mjs';
import { readFile } from 'node:fs/promises';

const actor = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: [] };
const policy = { allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] };
const secret = 's'.repeat(64);
test('Discord client integrates with real controller policy filtering, same-game instances, unknown game and lifecycle', async t => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/instance.json', import.meta.url)));
  const instances = Array.from({ length: 32 }, (_, i) => ({ ...structuredClone(fixture), id: `instance-${String(i).padStart(2, '0')}`,
    gameType: i === 31 ? 'previously-unknown-game' : fixture.gameType, displayName: `Instance ${i}`, policy: { ...fixture.policy, ...policy },
    container: { ...structuredClone(fixture.container), name: `container-${i}`, publishedPorts: [{ hostPort: 26000 + i, containerPort: 25565, protocol: 'tcp' }],
      requiredLabels: { 'io.atlasdominion.managed': 'true', 'io.atlasdominion.instance': `instance-${String(i).padStart(2, '0')}` } } }));
  instances[0].policy = { ...instances[0].policy, allowedDiscordUsers: [] };
  const states = new Map(instances.map(e => [e.id, 'exited']));
  const docker = { inspect: async entry => ({ data: { State: { Status: states.get(entry.id) } }, container: {
    start: async () => { states.set(entry.id, 'running'); }, stop: async () => { states.set(entry.id, 'exited'); }
  } }) };
  const controller = new ControllerService({ instances, docker, policy, capacity: { memoryMiB: 100000, cpuUnits: 100 },
    audit: { append: async () => {} }, timeoutMs: 2000, stopTimeoutSeconds: 1 });
  await controller.reconcile();
  const app = await createApplication(controller, [secret]); await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const client = new ControllerClient({ url: await app.getUrl(), secret });
  const first = await client.list(actor); assert.equal(first.items.length, 25); assert.ok(first.items.every(e => e.instanceId !== 'instance-00'));
  const second = await client.list(actor, first.nextCursor); assert.equal(second.items.length, 6); assert.equal(second.items.at(-1).gameType, 'previously-unknown-game');
  await assert.rejects(client.status('instance-00', actor), { code: 'UNKNOWN_INSTANCE' });
  await assert.rejects(client.status('unknown', actor), { code: 'UNKNOWN_INSTANCE' });
  let output;
  const discord = new DiscordService({ controller: client, applicationId: actor.guildId, pollMs: 1,
    fetchImpl: async (url, init) => { output = JSON.parse(init.body); return new Response('{}'); } });
  for (const action of ['start', 'stop']) {
    const id = action === 'start' ? '323456789012345678' : '423456789012345678';
    await discord.complete({ id, token: 'test' }, { action, instance: 'instance-31' }, actor);
    assert.match(output.content, /completed/); assert.equal(states.get('instance-31'), action === 'start' ? 'running' : 'exited');
  }
});
test('real transport bounds stalled controller requests and autocomplete deadline', async t => {
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new ControllerClient({ url: `http://127.0.0.1:${server.address().port}`, secret, timeoutMs: 30 });
  await assert.rejects(client.list(actor), { code: 'TIMEOUT' });
  client.timeoutMs = 5000;
  const discord = new DiscordService({ controller: client, applicationId: actor.guildId });
  const start = performance.now(); await assert.rejects(discord.autocomplete({ instance: '' }, actor), { code: 'TIMEOUT' });
  assert.ok(performance.now() - start < 2500);
});
test('upstream redirects cannot leak credentials, and oversized responses fail closed', async t => {
  let leaked = false;
  const target = createServer((req, res) => { leaked = true; res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  const server = createServer((req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}` }); res.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const s of [target, server]) { s.closeAllConnections(); s.close(); } });
  const client = new ControllerClient({ url: `http://127.0.0.1:${server.address().port}`, secret });
  await assert.rejects(client.list(actor), { code: 'DOCKER_UNAVAILABLE' }); assert.equal(leaked, false);
  client.fetch = async () => new Response('x'.repeat(262145));
  await assert.rejects(client.list(actor), { code: 'DOCKER_UNAVAILABLE' });
});
