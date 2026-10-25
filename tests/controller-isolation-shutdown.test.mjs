import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyIdentity, DockerAccess } from '../apps/docker-controller/docker.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';

const instance = JSON.parse(readFileSync(new URL('../infrastructure/games/minecraft/instance.example.json', import.meta.url)));
const actor = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: [] };
const policy = { allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] };
function inspection() {
  return { Id: 'approved-id', Name: `/${instance.container.name}`,
    Config: { Labels: structuredClone(instance.container.requiredLabels), User: '1000:1000' },
    State: { Status: 'running', ExitCode: 0, OOMKilled: false },
    Mounts: [{ Type: 'volume', Name: 'world', Destination: '/data' }],
    NetworkSettings: { Networks: { 'atlas-game-minecraft-survival': {} } },
    HostConfig: { RestartPolicy: { Name: 'no' }, Memory: 6144 * 1048576,
      PortBindings: { '25565/tcp': [{ HostIp: '127.0.0.1', HostPort: '25565' }] } } };
}
for (const user of ['', 'root', 'root:1000', '0', '000:1000']) test(`reject root identity ${JSON.stringify(user)}`, () => {
  const data = inspection(); data.Config.User = user;
  assert.throws(() => verifyIdentity(instance, data, ['127.0.0.1']), /IDENTITY_MISMATCH/);
});
for (const network of ['atlas-control', 'atlas-proxy', 'atlas-monitoring']) test(`reject deployed management network ${network}`, () => {
  for (const mode of ['attachment', 'primary']) {
    const data = inspection();
    if (mode === 'attachment') data.NetworkSettings.Networks[network] = {};
    else data.HostConfig.NetworkMode = network;
    assert.throws(() => verifyIdentity(instance, data, ['127.0.0.1']), /IDENTITY_MISMATCH/);
  }
});
for (const field of ['PidMode', 'IpcMode', 'NetworkMode']) test(`reject shared namespace ${field}`, () => {
  for (const value of ['host', 'container:other-id']) {
    const data = inspection(); data.HostConfig[field] = value;
    assert.throws(() => verifyIdentity(instance, data, ['127.0.0.1']), /IDENTITY_MISMATCH/);
  }
});
for (const source of ['/', '/srv/world/../..', '/var/run/docker.sock', '/run/docker.sock', '/srv/engine/docker.sock', '/etc', '/proc/1', '/var/lib/docker/volumes']) test(`reject dangerous read-only bind ${source}`, () => {
  const data = inspection(); data.Mounts.push({ Type: 'bind', Source: source, Destination: '/host-data', RW: false });
  assert.throws(() => verifyIdentity(instance, data, ['127.0.0.1']), /IDENTITY_MISMATCH/);
});
test('approved nonroot game volume and ordinary data bind remain usable', () => {
  const data = inspection(); data.Mounts.push({ Type: 'bind', Source: '/srv/game-data', Destination: '/extra-data' });
  verifyIdentity(instance, data, ['127.0.0.1']);
});

async function setup(state) {
  const entry = structuredClone(instance); Object.assign(entry.policy, policy);
  const data = inspection(), events = [];
  let stops = 0;
  const docker = new DockerAccess({ getContainer: () => ({ inspect: async () => structuredClone(data),
    stop: async () => { stops++; data.State = structuredClone(state); } }) }, ['127.0.0.1']);
  const service = new ControllerService({ instances: [entry], docker, policy,
    capacity: { memoryMiB: 6144, cpuUnits: 2 }, audit: { append: async event => events.push(event) },
    timeoutMs: 2000, stopTimeoutSeconds: 1 });
  await service.reconcile();
  return { service, data, events, stops: () => stops };
}
const request = { authorization: actor, idempotencyKey: 'shutdown-regression-key' };
for (const state of [
  { Status: 'exited', ExitCode: 0, OOMKilled: true },
  { Status: 'exited', ExitCode: 1, OOMKilled: false },
  { Status: 'exited', ExitCode: 137, OOMKilled: false },
  { Status: 'dead', ExitCode: 0, OOMKilled: false },
  { Status: 'created', ExitCode: 0, OOMKilled: false }
]) test(`abnormal stop ${JSON.stringify(state)} persists failure and cannot replay success`, async () => {
  const h = await setup(state);
  const { operation } = await h.service.request(instance.id, 'stop', request);
  for (let i = 0; i < 200 && h.service.locks.size; i++) await delay(5);
  assert.equal(h.service.locks.size, 0);
  const result = h.service.operation(operation.operationId, actor);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'OPERATION_CONFLICT');
  assert.equal(result.result, null);
  assert.equal((await h.service.request(instance.id, 'stop', request)).operation.state, 'failed');
  assert.equal(h.stops(), 1);
  assert.ok(h.events.some(event => event.outcome === 'failed'));
  assert.ok(!h.events.some(event => event.outcome === 'completed'));
  if (state.Status !== 'created') await assert.rejects(h.service.request(instance.id, 'stop', {
    ...request, idempotencyKey: 'fresh-shutdown-key'
  }), /OPERATION_CONFLICT/);
});
test('clean exited stop completes and releases resource reservation', async () => {
  const h = await setup({ Status: 'exited', ExitCode: 0, OOMKilled: false });
  const { operation } = await h.service.request(instance.id, 'stop', request);
  for (let i = 0; i < 200 && h.service.locks.size; i++) await delay(5);
  assert.equal(h.service.operation(operation.operationId, actor).state, 'completed');
  assert.equal(h.service.reservations.has(instance.id), false);
});
