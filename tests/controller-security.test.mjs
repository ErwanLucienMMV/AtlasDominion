import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { authenticate, context, allowed } from '../apps/docker-controller/security.mjs';
import { loadRegistry } from '../apps/docker-controller/registry.mjs';
import { DockerAccess, verifyIdentity } from '../apps/docker-controller/docker.mjs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/instance.json', import.meta.url)));
export function inspection(instance = fixture, state = 'exited') {
  return { Id: `id-${instance.id}`, Name: `/${instance.container.name}`, Config: { Labels: instance.container.requiredLabels }, State: { Status: state },
    HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' }, PortBindings: Object.fromEntries(instance.container.publishedPorts.map(p => [`${p.containerPort}/${p.protocol}`, [{ HostPort: String(p.hostPort), HostIp: '0.0.0.0' }]])) } };
}
test('authentication and guild/user intersection fail closed', () => {
  authenticate(`Bearer ${'a'.repeat(64)}`, ['a'.repeat(64)]);
  assert.throws(() => authenticate('Bearer wrong', ['a'.repeat(64)]), /UNAUTHENTICATED/);
  assert.throws(() => context({ guildId: 'bad' }), /INVALID_REQUEST/);
  assert.equal(allowed(fixture.policy, { guildId: '1', userId: '2', roleIds: [] }), false);
});
test('loader validates full candidate and duplicate IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'atlas-registry-'));
  await writeFile(join(dir, 'one.json'), JSON.stringify(fixture));
  assert.equal((await loadRegistry(dir)).length, 1);
  await writeFile(join(dir, 'two.json'), JSON.stringify(fixture));
  await assert.rejects(loadRegistry(dir), /Duplicate/);
  const other = await mkdtemp(join(tmpdir(), 'atlas-registry-'));
  await mkdir(join(other, 'invalid.json'));
  await assert.rejects(loadRegistry(other), /Invalid/);
});
test('Docker identity, restart, binding address and port checks', () => {
  verifyIdentity(fixture, inspection(), ['0.0.0.0']);
  for (const mutate of [d => d.Config.Labels = {}, d => d.Name = '/foreign', d => d.HostConfig.RestartPolicy.Name = 'always']) {
    const data = inspection(); mutate(data); assert.throws(() => verifyIdentity(fixture, data, ['0.0.0.0']), /IDENTITY_MISMATCH/);
  }
  assert.throws(() => verifyIdentity(fixture, inspection(), ['127.0.0.1']), /PORT_MISMATCH/);
  const data = inspection(); data.HostConfig.PortBindings['25565/tcp'][0].HostPort = '123';
  assert.throws(() => verifyIdentity(fixture, data, ['0.0.0.0']), /PORT_MISMATCH/);
});
test('missing container is distinct from Docker outage', async () => {
  for (const [statusCode, code] of [[404, 'MISSING_CONTAINER'], [500, 'DOCKER_UNAVAILABLE']]) {
    const docker = new DockerAccess({ getContainer: () => ({ inspect: async () => { throw { statusCode }; } }) }, []);
    await assert.rejects(docker.inspect(fixture), new RegExp(code));
  }
});
