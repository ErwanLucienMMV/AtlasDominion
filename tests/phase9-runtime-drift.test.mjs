// Requirements: SECURITY.md, PLAN.md Phase 9, PHASE_7_GAMES.md and
// PHASE_9_HARDENING.md. Synthetic Engine snapshots; no daemon access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdentity, DockerAccess } from '../apps/docker-controller/docker.mjs';
import { fixture } from './phase7-harness.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { actor, policy, request, until } from './phase2-harness.mjs';

function snapshot() {
  const f = fixture('palworld');
  Object.assign(f.data.HostConfig, { NanoCpus: 2e9, PidsLimit: 1024 });
  return f;
}

const drift = {
  'unlimited CPU': d => Object.assign(d.HostConfig, { NanoCpus: 0, CpuQuota: 0, CpuPeriod: 0 }),
  'unlimited PID count (-1)': d => { d.HostConfig.PidsLimit = -1; },
  'unlimited PID count (0)': d => { d.HostConfig.PidsLimit = 0; },
  'missing PID limit': d => { delete d.HostConfig.PidsLimit; },
  'another game network': d => { d.NetworkSettings.Networks['atlas-game-minecraft-survival'] = {}; },
  'default shared bridge attachment': d => { d.NetworkSettings.Networks.bridge = {}; },
  'missing explicit runtime user': d => { delete d.Config.User; },
};

for (const [name, mutate] of Object.entries(drift)) test(`runtime drift rejects ${name} before returning a mutation handle`, async () => {
  const { entry, data } = snapshot(); mutate(data);
  const handles = [];
  const docker = new DockerAccess({ getContainer(id) {
    handles.push(id); return { inspect: async () => structuredClone(data) };
  } }, ['127.0.0.1']);
  await assert.rejects(docker.inspect(entry), { code: 'IDENTITY_MISMATCH' });
  assert.deepEqual(handles, [entry.container.name]);
});

// Verify consequences through actual admission, not only the leaf validator.
for (const name of ['unlimited CPU', 'unlimited PID count (-1)', 'another game network']) {
  test(`controller cannot start an approved-label container with ${name}`, async () => {
    const { entry, data } = snapshot();
    Object.assign(entry.policy, policy());
    let starts = 0;
    const events = [];
    const docker = new DockerAccess({ getContainer: () => ({
      inspect: async () => structuredClone(data),
      start: async () => { starts++; data.State.Status = 'running'; },
    }) }, ['127.0.0.1']);
    const service = new ControllerService({ instances: [entry], docker, policy: policy(),
      capacity: { memoryMiB: 50000, cpuUnits: 50 }, audit: { append: async e => events.push(e) },
      timeoutMs: 2000, stopTimeoutSeconds: 1 });
    await service.reconcile();
    drift[name](data);
    let result, failure;
    try { result = await service.request(entry.id, 'start', request()); }
    catch (error) { failure = error; }
    await until(() => service.locks.size === 0);
    assert.equal(starts, 0, 'unsafe runtime drift must prevent mutation');
    assert.equal(failure?.code, 'IDENTITY_MISMATCH');
    assert.equal(result, undefined);
    assert.deepEqual(events, []);
    assert.equal(service.ready, false);
  });
}

for (const [name, mutate] of Object.entries({
  'changed hard memory': d => { d.HostConfig.Memory = 0; },
  'extra management TCP port': d => { d.HostConfig.PortBindings['8212/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '8212' }]; },
  'changed native UDP protocol': d => { d.HostConfig.PortBindings['8211/tcp'] = d.HostConfig.PortBindings['8211/udp']; delete d.HostConfig.PortBindings['8211/udp']; },
  'IPv6 wildcard substitution': d => { d.HostConfig.PortBindings['8211/udp'][0].HostIp = '::'; },
  'duplicate native binding': d => { d.HostConfig.PortBindings['8211/udp'].push(structuredClone(d.HostConfig.PortBindings['8211/udp'][0])); },
  'management network as secondary': d => { d.NetworkSettings.Networks['atlas-monitoring'] = {}; },
  'root UID with nonroot GID': d => { d.Config.User = '0000:1000'; },
  'read-only sensitive parent': d => { d.Mounts.push({ Type: 'bind', Source: '/var/lib/', Destination: '/extra', RW: false }); },
  'normalized socket destination': d => { d.Mounts.push({ Type: 'volume', Source: '/var/lib/docker/volumes/other/_data', Destination: '/x/../docker.sock' }); },
})) test(`existing isolation survives runtime drift: ${name}`, () => {
  const { entry, data } = snapshot(); mutate(data);
  assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']));
});

test('finite resource ceilings and the dedicated game bridge remain usable', () => {
  const { entry, data } = snapshot();
  assert.doesNotThrow(() => verifyIdentity(entry, data, ['127.0.0.1']));
});

test('a non-authorized actor cannot use idempotency replay to observe an operation', async () => {
  const { entry, data } = snapshot(); Object.assign(entry.policy, policy());
  const docker = new DockerAccess({ getContainer: () => ({ inspect: async () => structuredClone(data) }) }, ['127.0.0.1']);
  const service = new ControllerService({ instances: [entry], docker, policy: policy(),
    capacity: { memoryMiB: 50000, cpuUnits: 50 }, audit: { append: async () => {} }, timeoutMs: 2000, stopTimeoutSeconds: 1 });
  await service.reconcile();
  const result = await service.request(entry.id, 'stop', request());
  const denied = { ...actor, userId: '999999999999999999' };
  await assert.rejects(service.request(entry.id, 'stop', request(undefined, denied)), { code: 'FORBIDDEN' });
  assert.throws(() => service.operation(result.operation.operationId, denied), { code: 'FORBIDDEN' });
});
