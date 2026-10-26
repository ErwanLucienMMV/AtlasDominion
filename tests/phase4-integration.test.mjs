import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerAccess } from '../apps/docker-controller/docker.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { ControllerClient } from '../apps/discord-api/controller.mjs';
import { DiscordService } from '../apps/discord-api/service.mjs';
import { createDiscordApplication } from '../apps/discord-api/http.mjs';

const guildId = '123456789012345678', userId = '223456789012345678', applicationId = '323456789012345678';
const policy = { allowedDiscordGuilds: [guildId], allowedDiscordUsers: [userId], allowedDiscordRoles: [] };

test('signed Discord -> authenticated controller -> pinned Docker lifecycle, replay and restart reconciliation', async t => {
  const instance = JSON.parse(readFileSync(new URL('../infrastructure/games/minecraft/instance.example.json', import.meta.url)));
  Object.assign(instance.policy, policy);
  const data = { Id: 'preprovisioned-minecraft-id', Name: `/${instance.container.name}`,
    Config: { User: '1000:1000', Labels: instance.container.requiredLabels }, State: { Status: 'created' },
    NetworkSettings: { Networks: { [`atlas-game-${instance.id}`]: {} } },
    HostConfig: { NanoCpus: 2e9, PidsLimit: 1024, NetworkMode: `atlas-game-${instance.id}`, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' }, Memory: 6144 * 1048576,
      PortBindings: { '25565/tcp': [{ HostIp: '127.0.0.1', HostPort: '25565' }] } } };
  const calls = [], audit = [];
  const docker = new DockerAccess({ getContainer: name => {
    assert.ok([instance.container.name, data.Id].includes(name));
    return {
      inspect: async () => structuredClone(data),
      start: async () => { assert.equal(name, data.Id); calls.push('start'); data.State.Status = 'running'; },
      stop: async options => { assert.equal(name, data.Id); assert.deepEqual(options, { t: 90 }); calls.push('stop'); data.State.Status = 'exited'; }
    };
  } }, ['127.0.0.1']);
  const settings = { instances: [instance], docker, policy, capacity: { memoryMiB: 6144, cpuUnits: 2 },
    audit: { append: async event => audit.push(event) }, timeoutMs: 120000, stopTimeoutSeconds: 90 };
  const controller = new ControllerService(settings); await controller.reconcile();
  const secret = 's'.repeat(64), app = await createApplication(controller, [secret]);
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const client = new ControllerClient({ url: await app.getUrl(), secret });
  const deliveries = [];
  const service = new DiscordService({ controller: client, applicationId, pollMs: 1,
    fetchImpl: async (url, init) => { deliveries.push(JSON.parse(init.body)); return new Response('{}'); } });
  const keys = generateKeyPairSync('ed25519');
  const discord = await createDiscordApplication(service, { applicationId, policy,
    publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') });
  await discord.listen(0, '127.0.0.1'); t.after(() => discord.close());
  let sequence = 423456789012345678n;
  async function send(action, { id = String(sequence++), user = userId, target = instance.id } = {}) {
    const payload = { id, application_id: applicationId, token: 'mock-webhook', type: 2, guild_id: guildId,
      member: { user: { id: user }, roles: [] }, data: { name: 'server', options: [{ name: action, type: 1,
        options: action === 'list' ? [] : [{ name: 'instance', type: 3, value: target }] }] } };
    const body = JSON.stringify(payload), timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetch(`${await discord.getUrl()}/discord/interactions`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature-timestamp': timestamp,
        'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex') }, body });
    assert.equal(response.status, 200);
    return response.json();
  }
  async function complete(action, options) {
    const count = deliveries.length;
    assert.deepEqual(await send(action, options), { type: 5, data: { flags: 64 } });
    for (let i = 0; i < 400 && deliveries.length === count; i++) await delay(5);
    assert.equal(deliveries.length, count + 1);
    assert.deepEqual(deliveries.at(-1).allowed_mentions, { parse: [] });
    return deliveries.at(-1).content;
  }
  assert.match(await complete('list'), /minecraft-survival/);
  assert.match(await complete('status'), /created/);
  const startId = String(sequence++);
  assert.match(await complete('start', { id: startId }), /completed/);
  assert.match(await complete('status'), /unverified/);
  assert.equal((await send('start', { id: startId })).type, 5);
  assert.match(await complete('start'), /already_running/);
  const restarted = new ControllerService(settings); await restarted.reconcile();
  assert.ok(restarted.reservations.has(instance.id));
  assert.equal((await restarted.status(instance.id, { guildId, userId, roleIds: [] })).docker, 'running');
  assert.match(await complete('stop'), /completed/);
  assert.match(await complete('status'), /exited/);
  assert.match(await complete('stop'), /already_stopped/);
  assert.match(await complete('start'), /completed/);
  assert.equal(data.State.Status, 'running');
  assert.match(await complete('status', { target: 'not-registered' }), /Unknown or inaccessible/);
  assert.equal((await send('stop', { user: '923456789012345678' })).type, 4);
  assert.deepEqual(calls, ['start', 'stop', 'start']);
  assert.ok(audit.some(event => event.operation === 'stop' && event.outcome === 'completed'));
  assert.ok(!JSON.stringify(audit).includes(userId));
});
