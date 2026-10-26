// Expectations: SECURITY.md, SERVER_REGISTRY.md, docs/PHASE_4_MINECRAFT.md.
// Engine responses are synthetic. No containers, volumes or host ports are changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerAccess, verifyIdentity } from '../apps/docker-controller/docker.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { validateRegistry } from '../libs/server-registry/index.mjs';

const example = JSON.parse(readFileSync(new URL('../infrastructure/games/minecraft/instance.example.json', import.meta.url)));
const actor = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: [] };
const policy = { allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] };
const stack = JSON.parse(readFileSync(new URL('../infrastructure/games/minecraft/compose.json', import.meta.url)));

test('Minecraft deployment exposes only the reviewed game network and no management namespaces', () => {
  const game = stack.services.minecraft;
  assert.deepEqual(Object.keys(stack.services), ['minecraft']);
  assert.deepEqual(game.networks, ['game']);
  assert.deepEqual(Object.keys(stack.networks), ['game']);
  for (const key of ['network_mode', 'pid', 'ipc', 'privileged', 'devices', 'cap_add', 'volumes_from', 'external_links', 'links', 'depends_on']) {
    assert.equal(game[key], undefined, `unexpected privilege or coupling: ${key}`);
  }
  assert.deepEqual(game.security_opt, ['no-new-privileges:true']);
  assert.deepEqual(game.cap_drop, ['ALL']);
  assert.equal(game.pids_limit, 512);
});

test('Minecraft world uses only a writable external named volume, never anonymous or host mounts', () => {
  assert.deepEqual(stack.services.minecraft.volumes, [{ type: 'volume', source: 'world', target: '/data' }]);
  assert.deepEqual(Object.keys(stack.volumes), ['world']);
  assert.equal(stack.volumes.world.external, true);
  assert.match(stack.volumes.world.name, /^\$\{MINECRAFT_DATA_VOLUME:\?/);
});

test('Minecraft logs are bounded and no static RCON password is committed', () => {
  assert.deepEqual(stack.services.minecraft.logging, { driver: 'local', options: { 'max-size': '10m', 'max-file': '3' } });
  assert.equal(stack.services.minecraft.environment.RCON_PASSWORD, undefined);
  assert.equal(stack.services.minecraft.ports.some(p => p.target === 25575), false);
});

test('Minecraft save window is shorter than Compose grace and explicit controller stop window', () => {
  const game = stack.services.minecraft;
  assert.equal(game.stop_signal, 'SIGTERM');
  assert.equal(game.environment.STOP_SERVER_ANNOUNCE_DELAY, '0');
  assert.ok(Number(game.environment.STOP_DURATION) < 90);
  assert.equal(game.stop_grace_period, '90s');
  assert.equal(game.restart, 'no');
  assert.equal(game.pull_policy, 'never');
});

const request = key => ({ authorization: structuredClone(actor), idempotencyKey: key.padEnd(20, '_') });
function inspection() {
  return { Id: 'immutable-minecraft-id', Name: `/${example.container.name}`,
    Config: { Labels: structuredClone(example.container.requiredLabels), User: '1000:1000' },
    State: { Status: 'exited', ExitCode: 0, OOMKilled: false },
    Mounts: [{ Type: 'volume', Name: 'reviewed-world', Destination: '/data', RW: true }],
    NetworkSettings: { Networks: { 'atlas-game-minecraft-survival': {} } },
    HostConfig: { NanoCpus: 2e9, PidsLimit: 1024, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' }, Memory: 6144 * 1048576,
      NetworkMode: 'atlas-game-minecraft-survival', Privileged: false, PublishAllPorts: false,
      PortBindings: { '25565/tcp': [{ HostIp: '127.0.0.1', HostPort: '25565' }] } } };
}
function harness({ capacity = { memoryMiB: 6144, cpuUnits: 2 }, denyInstance = false } = {}) {
  const entry = structuredClone(example);
  if (!denyInstance) Object.assign(entry.policy, structuredClone(policy));
  const data = inspection(), calls = [], events = [];
  const hooks = { stop: null, start: null };
  const docker = new DockerAccess({ getContainer(name) {
    return {
      async inspect() { calls.push(['inspect', name]); return structuredClone(data); },
      async start() { calls.push(['start', name]); if (hooks.start) await hooks.start(); data.State.Status = 'running'; },
      async stop(options) { calls.push(['stop', name, options]); data.State.Status = 'exited'; if (hooks.stop) await hooks.stop(); }
    };
  } }, ['127.0.0.1']);
  const service = new ControllerService({ instances: [entry], docker, policy: structuredClone(policy), capacity,
    audit: { append: async event => events.push(structuredClone(event)) }, timeoutMs: 120000, stopTimeoutSeconds: 90 });
  return { entry, data, calls, events, hooks, service };
}
async function settled(h) {
  const deadline = Date.now() + 3000;
  while (h.service.locks.size && Date.now() < deadline) await delay(5);
  assert.equal(h.service.locks.size, 0, 'operation must release its lock');
}
const mutations = [
  ['foreign container name', d => { d.Name = '/unregistered'; }, 'IDENTITY_MISMATCH'],
  ['missing immutable ID', d => { delete d.Id; }, 'IDENTITY_MISMATCH'],
  ['spoofed instance label', d => { d.Config.Labels['io.atlasdominion.instance'] = 'foreign'; }, 'IDENTITY_MISMATCH'],
  ['missing managed label', d => { delete d.Config.Labels['io.atlasdominion.managed']; }, 'IDENTITY_MISMATCH'],
  ['automatic restart', d => { d.HostConfig.RestartPolicy.Name = 'unless-stopped'; }, 'IDENTITY_MISMATCH'],
  ['host networking', d => { d.HostConfig.NetworkMode = 'host'; }, 'IDENTITY_MISMATCH'],
  ['privileged workload', d => { d.HostConfig.Privileged = true; }, 'IDENTITY_MISMATCH'],
  ['publish-all ports', d => { d.HostConfig.PublishAllPorts = true; }, 'IDENTITY_MISMATCH'],
  ['unlimited memory', d => { d.HostConfig.Memory = 0; }, 'IDENTITY_MISMATCH'],
  ['one byte below memory contract', d => { d.HostConfig.Memory--; }, 'IDENTITY_MISMATCH'],
  ['one byte above memory contract', d => { d.HostConfig.Memory++; }, 'IDENTITY_MISMATCH'],
  ['public IPv4 wildcard', d => { d.HostConfig.PortBindings['25565/tcp'][0].HostIp = '0.0.0.0'; }, 'PORT_MISMATCH'],
  ['public IPv6 wildcard', d => { d.HostConfig.PortBindings['25565/tcp'][0].HostIp = '::'; }, 'PORT_MISMATCH'],
  ['implicit bind address', d => { delete d.HostConfig.PortBindings['25565/tcp'][0].HostIp; }, 'PORT_MISMATCH'],
  ['additional RCON exposure', d => { d.HostConfig.PortBindings['25575/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '25575' }]; }, 'PORT_MISMATCH'],
  ['additional query exposure', d => { d.HostConfig.PortBindings['25565/udp'] = [{ HostIp: '127.0.0.1', HostPort: '25565' }]; }, 'PORT_MISMATCH'],
  ['duplicate native binding', d => { d.HostConfig.PortBindings['25565/tcp'].push({ HostIp: '127.0.0.1', HostPort: '25565' }); }, 'PORT_MISMATCH'],
  ['missing native binding', d => { d.HostConfig.PortBindings = {}; }, 'PORT_MISMATCH'],
  ['empty native binding', d => { d.HostConfig.PortBindings['25565/tcp'] = []; }, 'PORT_MISMATCH'],
  ['existing application port collision', d => { d.HostConfig.PortBindings['25565/tcp'][0].HostPort = '4242'; }, 'PORT_MISMATCH']
];
for (const [name, mutate, code] of mutations) test(`Minecraft rejects ${name} before any mutation`, async () => {
  const h = harness(); await h.service.reconcile(); mutate(h.data);
  await assert.rejects(h.service.request(h.entry.id, 'start', request('unsafe')), { code });
  assert.equal(h.calls.filter(([action]) => action !== 'inspect').length, 0);
  assert.equal(h.service.ready, false);
});

for (const [name, capacity] of [
  ['one MiB short', { memoryMiB: 6143, cpuUnits: 2 }],
  ['fractional CPU short', { memoryMiB: 6144, cpuUnits: 1.999999 }]
]) test(`Minecraft capacity fails closed when ${name}`, async () => {
  const h = harness({ capacity }); await h.service.reconcile();
  await assert.rejects(h.service.request(h.entry.id, 'start', request('capacity')), { code: 'RESOURCE_EXHAUSTED' });
  assert.equal(h.calls.some(([action]) => action === 'start'), false);
});

test('exact capacity admits one start and concurrent replays mutate only once', async () => {
  const h = harness(); await h.service.reconcile();
  const results = await Promise.all(Array.from({ length: 30 }, () => h.service.request(h.entry.id, 'start', request('same-key'))));
  await settled(h);
  assert.equal(new Set(results.map(r => r.operation.operationId)).size, 1);
  assert.deepEqual(h.calls.filter(([action]) => action === 'start'), [['start', h.data.Id]]);
  assert.equal((await h.service.status(h.entry.id, actor)).readiness, 'unverified');
  assert.equal(h.events.filter(e => e.outcome === 'completed').length, 1);
  assert.ok(!JSON.stringify(h.events).includes(actor.userId));
});

test('checked-in deny-all instance cannot be operated by globally authorized caller', async () => {
  const h = harness({ denyInstance: true }); await h.service.reconcile(); h.calls.length = 0;
  for (const action of ['start', 'stop']) await assert.rejects(h.service.request(h.entry.id, action, request(action)), { code: 'UNKNOWN_INSTANCE' });
  await assert.rejects(h.service.status(h.entry.id, actor), { code: 'UNKNOWN_INSTANCE' });
  assert.deepEqual(h.calls, []);
});

for (const state of ['paused', 'restarting', 'removing', 'unknown']) test(`Minecraft ${state} state is never mutated`, async () => {
  const h = harness(); h.data.State.Status = state; await h.service.reconcile();
  for (const action of ['start', 'stop']) await assert.rejects(h.service.request(h.entry.id, action, request(action)), { code: 'OPERATION_CONFLICT' });
  assert.equal(h.calls.some(([action]) => action !== 'inspect'), false);
});

test('container replacement between acceptance and execution cannot redirect start', async () => {
  const h = harness(); await h.service.reconcile();
  h.service.audit.append = async event => {
    h.events.push(event);
    if (event.outcome === 'accepted') h.data.Id = 'replacement-id';
  };
  const { operation } = await h.service.request(h.entry.id, 'start', request('replacement'));
  await settled(h);
  assert.equal(h.service.operation(operation.operationId, actor).error, 'IDENTITY_MISMATCH');
  assert.equal(h.calls.some(([action]) => action === 'start'), false);
});

test('second Minecraft instance cannot reuse native port, container ownership or stable identity', () => {
  for (const field of ['port', 'container', 'id']) {
    const second = structuredClone(example);
    second.id = 'minecraft-creative'; second.container.name = 'game-minecraft-creative';
    second.container.requiredLabels['io.atlasdominion.instance'] = second.id;
    second.container.publishedPorts[0].hostPort = 25566;
    if (field === 'port') second.container.publishedPorts[0].hostPort = 25565;
    if (field === 'container') second.container.name = example.container.name;
    if (field === 'id') { second.id = example.id; second.container.requiredLabels['io.atlasdominion.instance'] = example.id; }
    assert.throws(() => validateRegistry([example, second]), /Duplicate|Conflicting/);
  }
});

test('healthy Docker healthcheck never upgrades unverified Minecraft gameplay readiness', async () => {
  const h = harness(); h.data.State.Status = 'running'; h.data.State.Health = { Status: 'healthy' };
  await h.service.reconcile();
  assert.equal((await h.service.status(h.entry.id, actor)).readiness, 'unverified');
});

test('idempotent replay is reauthorized after instance access is revoked', async () => {
  const h = harness(); await h.service.reconcile();
  await h.service.request(h.entry.id, 'start', request('revoked')); await settled(h);
  h.service.instances[0].policy.allowedDiscordUsers = [];
  await assert.rejects(h.service.request(h.entry.id, 'start', request('revoked')), { code: 'UNKNOWN_INSTANCE' });
  assert.equal(h.calls.filter(([action]) => action === 'start').length, 1);
});

for (const action of ['create', 'exec', 'remove', 'restart', 'pull', 'kill']) test(`Minecraft cannot request arbitrary Docker ${action}`, async () => {
  const h = harness(); await h.service.reconcile(); h.calls.length = 0;
  await assert.rejects(h.service.request(h.entry.id, action, request('forbidden')), { code: 'INVALID_REQUEST' });
  assert.deepEqual(h.calls, []);
});

for (const field of ['image', 'containerId', 'command', 'mounts', 'ports', 'endpoint']) test(`Minecraft lifecycle rejects injected ${field}`, async () => {
  const h = harness(); await h.service.reconcile(); h.calls.length = 0;
  await assert.rejects(h.service.request(h.entry.id, 'start', { ...request('injection'), [field]: 'attacker-controlled' }), { code: 'INVALID_REQUEST' });
  assert.deepEqual(h.calls, []);
});

test('graceful save retains reservation and blocks conflicting start until stop finishes', async t => {
  const h = harness(); h.data.State.Status = 'running'; await h.service.reconcile();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  h.hooks.stop = () => gate;
  const { operation } = await h.service.request(h.entry.id, 'stop', request('saving'));
  try {
    assert.equal(h.service.reservations.has(h.entry.id), true);
    await assert.rejects(h.service.request(h.entry.id, 'start', request('during-save')), { code: 'OPERATION_CONFLICT' });
    assert.equal(h.events.some(e => e.outcome === 'completed'), false);
  } finally { release(); await settled(h); }
  assert.equal(h.service.operation(operation.operationId, actor).state, 'completed');
  assert.equal(h.service.reservations.has(h.entry.id), false);
});

test('Engine failure details cannot leak through failed Minecraft operation or audit', async () => {
  const h = harness(); await h.service.reconcile();
  const secret = 'private-engine-token-and-host-world-path';
  h.hooks.start = async () => { throw new Error(secret); };
  const { operation } = await h.service.request(h.entry.id, 'start', request('engine-failure'));
  await settled(h);
  const result = h.service.operation(operation.operationId, actor);
  assert.equal(result.state, 'failed'); assert.equal(result.error, 'DOCKER_UNAVAILABLE');
  assert.ok(!JSON.stringify([result, h.events]).includes(secret));
});

// Defense-in-depth expectations derived from the Markdown isolation requirements.
// These deliberately expose absent runtime checks; provisioning review remains mandatory.
for (const [name, mutate] of [
  ['Docker socket mount', d => { d.Mounts.push({ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true }); }],
  ['control network attachment', d => { d.NetworkSettings.Networks.control = {}; }],
  ['proxy network attachment', d => { d.NetworkSettings.Networks.proxy = {}; }],
  ['root execution', d => { d.Config.User = '0:0'; }],
  ['host PID namespace', d => { d.HostConfig.PidMode = 'host'; }],
  ['host root filesystem mount', d => { d.Mounts.push({ Type: 'bind', Source: '/', Destination: '/host', RW: true }); }]
]) test(`security expectation: runtime identity rejects ${name}`, () => {
  const data = inspection(); mutate(data);
  assert.throws(() => verifyIdentity(example, data, ['127.0.0.1']), /IDENTITY_MISMATCH/);
});

// PHASE_4_MINECRAFT.md requires investigation of nonzero exits/OOM, not automatic acceptance.
for (const [name, terminal] of [
  ['SIGKILL exit 137', { Status: 'exited', ExitCode: 137, OOMKilled: false }],
  ['OOM termination', { Status: 'exited', ExitCode: 137, OOMKilled: true }],
  ['nonzero exit', { Status: 'exited', ExitCode: 1, OOMKilled: false }],
  ['dead container', { Status: 'dead', ExitCode: 137, OOMKilled: false }]
]) test(`acceptance expectation: ${name} is not reported as a successful graceful stop`, async () => {
  const h = harness(); h.data.State.Status = 'running'; await h.service.reconcile();
  h.hooks.stop = async () => { Object.assign(h.data.State, terminal); };
  const { operation } = await h.service.request(h.entry.id, 'stop', request('abnormal-stop'));
  await settled(h);
  assert.deepEqual(h.calls.find(([action]) => action === 'stop'), ['stop', h.data.Id, { t: 90 }]);
  assert.notEqual(h.service.operation(operation.operationId, actor).state, 'completed', 'abnormal termination must require investigation');
  assert.equal(h.events.some(e => e.operation === 'stop' && e.outcome === 'completed'), false);
});
