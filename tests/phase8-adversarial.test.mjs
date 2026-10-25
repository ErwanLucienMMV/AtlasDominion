import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistry } from '../libs/server-registry/index.mjs';
import { fleet, actor, harness, settled } from './phase8-harness.mjs';

// Exercise the final entry so validation cannot silently accept a valid prefix.
const invalidRegistry = {
  'path traversal ID': e => { e.id = '../host'; },
  'metric label injection': e => { e.gameType = 'x"}\ninjected 1'; },
  'Docker socket container reference': e => { e.container.name = '/var/run/docker.sock'; },
  'executable adapter': e => { e.adapter.lifecycle = '../../plugin.mjs'; },
  'shell stop strategy': e => { e.adapter.stop = 'sh -c id'; },
  'live backup claim': e => { e.adapter.backup = 'live-volume'; },
  'extra adapter command': e => { e.adapter.command = 'id'; },
  'extra container mount': e => { e.container.mounts = ['/var/run/docker.sock']; },
  'extra Docker endpoint': e => { e.container.endpoint = 'tcp://host:2375'; },
  'unknown policy permission': e => { e.policy.admin = true; },
  'automatic restart': e => { e.policy.allowAutoRestart = true; },
  'zero memory reservation': e => { e.resources.admissionMemoryMiB = 0; },
  'negative CPU reservation': e => { e.resources.admissionCpuUnits = -1; },
  'NaN CPU reservation': e => { e.resources.admissionCpuUnits = NaN; },
  'infinite CPU reservation': e => { e.resources.admissionCpuUnits = Infinity; },
  'unsafe integer memory': e => { e.resources.hardMemoryMiB = Number.MAX_SAFE_INTEGER + 1; },
  'port zero': e => { e.container.publishedPorts[0].hostPort = 0; },
  'port overflow': e => { e.container.publishedPorts[0].hostPort = 65536; },
  'fractional port': e => { e.container.publishedPorts[0].containerPort = 1.5; },
  'string port': e => { e.container.publishedPorts[0].hostPort = '1234'; },
  'protocol case confusion': e => { e.container.publishedPorts[0].protocol = 'TCP'; },
  'duplicate allowlist': e => { e.policy.allowedDiscordUsers.push(actor.userId); },
  'numeric Discord identity': e => { e.policy.allowedDiscordUsers = [123456789012345678]; },
  'overlong allowlist': e => { e.policy.allowedDiscordRoles = Array.from({ length: 1001 }, (_, i) => String(323456789012345678n + BigInt(i))); },
  'oversized display name': e => { e.displayName = 'x'.repeat(101); }
};
for (const [name, mutate] of Object.entries(invalidRegistry)) test(`unknown-game fleet rejects ${name}`, () => {
  const entries = fleet(50); mutate(entries.at(-1));
  assert.throws(() => validateRegistry(entries));
});

test('validated registry is detached from caller-owned nested objects', () => {
  const input = fleet(50), result = validateRegistry(input);
  input[49].policy.allowedDiscordUsers.length = 0;
  input[49].container.publishedPorts[0].hostPort = 1;
  assert.deepEqual(result[49].policy.allowedDiscordUsers, [actor.userId]);
  assert.notEqual(result[49].container.publishedPorts[0].hostPort, 1);
});

const drift = {
  'privileged mode': d => { d.HostConfig.Privileged = true; },
  'host networking': d => { d.HostConfig.NetworkMode = 'host'; },
  'shared container networking': d => { d.HostConfig.NetworkMode = 'container:controller'; },
  'host PID namespace': d => { d.HostConfig.PidMode = 'host'; },
  'shared IPC namespace': d => { d.HostConfig.IpcMode = 'container:controller'; },
  'control network': d => { d.NetworkSettings = { Networks: { 'atlas-control': {} } }; },
  'proxy network': d => { d.HostConfig.NetworkMode = 'proxy'; },
  'Docker socket volume': d => { d.Mounts.push({ Type: 'volume', Destination: '/var/run/docker.sock' }); },
  'normalized host bind': d => { d.Mounts.push({ Type: 'bind', Source: '/safe/../etc', Destination: '/config' }); },
  'root user': d => { d.Config.User = '000:1000'; },
  'granted capability': d => { d.HostConfig.CapAdd = ['SYS_ADMIN']; },
  'disabled privilege restriction': d => { d.HostConfig.SecurityOpt = ['no-new-privileges:false']; },
  'unconfined seccomp': d => { d.HostConfig.SecurityOpt.push('seccomp=unconfined'); },
  'automatic restart': d => { d.HostConfig.RestartPolicy.Name = 'always'; },
  'removed memory limit': d => { d.HostConfig.Memory = 0; },
  'spoofed identity label': d => { d.Config.Labels['io.atlasdominion.instance'] = 'nebula-00'; },
  'wildcard IPv4 publish': d => { Object.values(d.HostConfig.PortBindings)[0][0].HostIp = '0.0.0.0'; },
  'wildcard IPv6 publish': d => { Object.values(d.HostConfig.PortBindings)[0][0].HostIp = '::'; },
  'extra public port': d => { d.HostConfig.PortBindings['2375/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '2375' }]; },
  'publish all ports': d => { d.HostConfig.PublishAllPorts = true; }
};
test('configuration drift on the last unknown game blocks mutation and recovers without eviction', async t => {
  const h = await harness(t, fleet(50)), id = 'nebula-49', original = structuredClone(h.states.get(id));
  for (const [name, mutate] of Object.entries(drift)) await t.test(name, async () => {
    h.states.set(id, structuredClone(original)); mutate(h.states.get(id));
    await assert.rejects(h.client.operate(id, 'start', actor, '423456789012345678'), error =>
      ['IDENTITY_MISMATCH', 'PORT_MISMATCH'].includes(error.code));
    assert.equal(h.service.ready, false);
    assert.equal(h.service.locks.size, 0);
    assert.equal(h.calls.filter(c => ['start', 'stop'].includes(c[0])).length, 0);
    h.states.set(id, structuredClone(original)); await h.service.reconcile();
    assert.equal(h.service.ready, true);
  });
});

test('cross-instance replay and operation reads enforce current authorization', async t => {
  const entries = fleet(3); entries[2].policy.allowedDiscordUsers = ['923456789012345678'];
  const h = await harness(t, entries), key = '423456789012345678';
  const first = await h.client.operate('nebula-00', 'start', actor, key); await settled(h.service);
  const replay = await h.client.operate('nebula-00', 'start', actor, key);
  assert.equal(replay.operationId, first.operationId);
  // Discord deliberately derives different keys per action. Test raw API key
  // reuse separately to exercise the controller's conflicting-action guard.
  const raw = { authorization: actor, idempotencyKey: 'raw-phase8-replay-key' };
  await h.service.request('nebula-00', 'start', raw);
  await assert.rejects(h.service.request('nebula-00', 'stop', raw), { code: 'OPERATION_CONFLICT' });
  const other = await h.client.operate('nebula-01', 'start', actor, key); await settled(h.service);
  assert.notEqual(other.operationId, first.operationId);
  const denied = { ...actor, userId: '923456789012345678' };
  await assert.rejects(h.client.operation(first.operationId, denied), { code: 'FORBIDDEN' });
  await assert.rejects(h.client.operate('nebula-02', 'start', actor, key), { code: 'UNKNOWN_INSTANCE' });
  h.service.instances[0].policy.allowedDiscordUsers = [];
  await assert.rejects(h.client.operate('nebula-00', 'start', actor, key), { code: 'UNKNOWN_INSTANCE' });
  await assert.rejects(h.client.operation(first.operationId, actor), { code: 'UNKNOWN_INSTANCE' });
  assert.deepEqual(h.calls.filter(c => c[0] === 'start').map(c => c[1]), ['nebula-00', 'nebula-01']);
});

test('hostile HTTP pagination and provisioning payloads never reach Docker mutation', async t => {
  const h = await harness(t, fleet(50)), url = await h.app.getUrl();
  const headers = { authorization: `Bearer ${h.secret}`, 'content-type': 'application/json',
    'x-atlas-authorization-context': Buffer.from(JSON.stringify(actor)).toString('base64url') };
  const queries = ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=1e2', 'limit=Infinity',
    'limit=1&limit=2', 'cursor=../etc', 'cursor=W10', 'cursor=LTE', 'cursor=MQ&cursor=Mg',
    'image=alpine', 'limit[]=1', 'cursor=' + 'A'.repeat(129)];
  for (const query of queries) await t.test(query.slice(0, 60), async () => {
    const response = await fetch(`${url}/v1/servers?${query}`, { headers });
    assert.equal(response.status, 400); assert.equal((await response.json()).code, 'INVALID_REQUEST');
  });
  for (const extra of [{ image: 'alpine' }, { command: 'id' }, { containerId: 'host' }, { mounts: ['/'] },
    { authorization: { ...actor, admin: true } }, { idempotencyKey: 'x'.repeat(129) }]) {
    const response = await fetch(`${url}/v1/servers/nebula-49/start`, { method: 'POST', headers,
      body: JSON.stringify({ authorization: actor, idempotencyKey: '423456789012345678', ...extra }) });
    assert.equal(response.status, 400);
  }
  const unauthenticated = await fetch(`${url}/v1/servers/nebula-49/start`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: '{bad-json' });
  assert.equal(unauthenticated.status, 401);
  assert.equal(h.calls.filter(c => ['start', 'stop'].includes(c[0])).length, 0);
  assert.equal(h.service.operations.size, 0);
});

for (const state of ['paused', 'restarting', 'removing']) test(`${state} containers reserve capacity across unknown game types`, async t => {
  const h = await harness(t, fleet(3), { memoryMiB: 64, cpuUnits: 1 });
  h.states.get('nebula-00').State.Status = state; await h.service.reconcile();
  await assert.rejects(h.client.operate('nebula-02', 'start', actor, '423456789012345678'), { code: 'RESOURCE_EXHAUSTED' });
  assert.equal(h.calls.filter(c => ['start', 'stop'].includes(c[0])).length, 0);
});

test('empty per-instance policy hides an unknown game from HTTP and Discord and rejects stop', async t => {
  const entries = fleet(50); entries[49].policy.allowedDiscordUsers = [];
  const h = await harness(t, entries); h.states.get('nebula-49').State.Status = 'running';
  assert.deepEqual(await h.discord.autocomplete({ instance: 'nebula-49' }, actor), []);
  await assert.rejects(h.client.status('nebula-49', actor), { code: 'UNKNOWN_INSTANCE' });
  await assert.rejects(h.client.operate('nebula-49', 'stop', actor, '423456789012345678'), { code: 'UNKNOWN_INSTANCE' });
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, 0);
});
