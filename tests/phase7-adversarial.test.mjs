import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdentity } from '../apps/docker-controller/docker.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { validateRegistry } from '../libs/server-registry/index.mjs';
import { games, fixture, access, actor, policy } from './phase7-harness.mjs';

const rejected = {
  'added SYS_ADMIN capability': d => { d.HostConfig.CapAdd = ['SYS_ADMIN']; },
  'removed capability drop': d => { d.HostConfig.CapDrop = []; },
  'removed no-new-privileges': d => { d.HostConfig.SecurityOpt = []; },
  'unconfined seccomp': d => { d.HostConfig.SecurityOpt.push('seccomp=unconfined'); },
  'raw host disk device': d => { d.HostConfig.Devices = [{ PathOnHost: '/dev/sda', PathInContainer: '/dev/sda', CgroupPermissions: 'rwm' }]; },
  'host management network attachment': d => { d.NetworkSettings.Networks['atlas-control'] = {}; },
  'privileged container': d => { d.HostConfig.Privileged = true; },
  'automatic port publication': d => { d.HostConfig.PublishAllPorts = true; },
  'wildcard IPv4 publication': d => { Object.values(d.HostConfig.PortBindings)[0][0].HostIp = '0.0.0.0'; },
  'wildcard IPv6 publication': d => { Object.values(d.HostConfig.PortBindings)[0][0].HostIp = '::'; },
  'duplicate native port binding': d => { const bindings = Object.values(d.HostConfig.PortBindings)[0]; bindings.push({ ...bindings[0] }); },
  'missing native port': d => { delete d.HostConfig.PortBindings[Object.keys(d.HostConfig.PortBindings)[0]]; },
  'TCP substituted for UDP': d => { const key = Object.keys(d.HostConfig.PortBindings)[0]; d.HostConfig.PortBindings[key.replace('/udp', '/tcp')] = d.HostConfig.PortBindings[key]; delete d.HostConfig.PortBindings[key]; },
  'REST administration exposure': d => { d.HostConfig.PortBindings['8212/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '8212' }]; },
  'restart ownership drift': d => { d.HostConfig.RestartPolicy.Name = 'unless-stopped'; },
  'removed memory limit': d => { d.HostConfig.Memory = 0; },
  'spoofed instance label': d => { d.Config.Labels['io.atlasdominion.instance'] = 'other-instance'; },
  'renamed container': d => { d.Name += '-replacement'; },
  'host PID namespace': d => { d.HostConfig.PidMode = 'host'; },
  'container network namespace': d => { d.HostConfig.NetworkMode = 'container:controller'; },
  'Docker socket volume': d => { d.Mounts.push({ Type: 'volume', Name: 'socket', Destination: '/var/run/docker.sock' }); }
};
for (const game of games) {
  test(`${game}: faithful restricted inspection is accepted`, () => {
    const { entry, data } = fixture(game);
    assert.doesNotThrow(() => verifyIdentity(entry, data, ['127.0.0.1']));
  });
  for (const [name, mutate] of Object.entries(rejected)) test(`${game}: runtime must reject ${name}`, () => {
    const { entry, data } = fixture(game); mutate(data);
    assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']), /IDENTITY_MISMATCH|PORT_MISMATCH/);
  });
  test(`${game}: empty instance allowlists deny start, stop and status before Docker access`, async () => {
    const { entry } = fixture(game); let inspections = 0;
    const service = new ControllerService({ instances: [entry], policy,
      docker: { inspect: async () => { inspections++; throw new Error('must not reach Engine'); } },
      capacity: { memoryMiB: 65536, cpuUnits: 16 }, timeoutMs: 180000, stopTimeoutSeconds: 120,
      audit: { append: async () => {} } });
    for (const action of ['start', 'stop']) await assert.rejects(service.request(entry.id, action,
      { authorization: actor, idempotencyKey: 'phase7-denied-operation' }), /UNKNOWN_INSTANCE/);
    await assert.rejects(service.status(entry.id, actor), /UNKNOWN_INSTANCE/);
    assert.equal(inspections, 0);
  });
  test(`${game}: healthy Docker probe never promotes unverified gameplay readiness`, async () => {
    const { entry, data } = fixture(game); Object.assign(entry.policy, policy);
    data.State = { Status: 'running', Health: { Status: 'healthy' } };
    const { docker } = access(data);
    const service = new ControllerService({ instances: [entry], policy, docker,
      capacity: { memoryMiB: 65536, cpuUnits: 16 }, timeoutMs: 180000, stopTimeoutSeconds: 120,
      audit: { append: async () => {} } });
    assert.equal((await service.status(entry.id, actor)).readiness, 'unverified');
  });
  test(`${game}: same-game second instance cannot reuse host UDP ports`, () => {
    const { entry } = fixture(game), other = structuredClone(entry);
    other.id += '-two'; other.container.name += '-two'; other.container.requiredLabels['io.atlasdominion.instance'] = other.id;
    assert.throws(() => validateRegistry([entry, other]), /Conflicting published port/);
    other.container.publishedPorts.forEach(p => { p.hostPort += 100; });
    assert.equal(validateRegistry([entry, other]).length, 2);
  });
  test(`${game}: replaced immutable container ID is rejected`, async () => {
    const { entry, data } = fixture(game), { docker } = access(data);
    await assert.rejects(docker.inspect(entry, 'previous-container-id'), /IDENTITY_MISMATCH/);
  });
}
