import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerAccess, verifyIdentity } from '../apps/docker-controller/docker.mjs';
import { fixture } from './phase7-harness.mjs';

for (const source of ['/var/', '/var/lib/', '/var/lib/../lib/', '/var//lib//', '/var/lib/docker/../']) {
  test(`sensitive parent bind with trailing separator ${source} fails closed`, () => {
    const { entry, data } = fixture('palworld');
    data.Mounts = [{ Type: 'bind', Source: source, Destination: '/data', RW: true }];
    assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']), { code: 'IDENTITY_MISMATCH' });
  });
}

for (const source of ['/srv/game-data/', '/var/lib/games/world/', '/var/lib/docker-other/']) {
  test(`ordinary game bind with trailing separator ${source} remains supported`, () => {
    const { entry, data } = fixture('palworld');
    data.Mounts = [{ Type: 'bind', Source: source, Destination: '/data', RW: true }];
    assert.doesNotThrow(() => verifyIdentity(entry, data, ['127.0.0.1']));
  });
}

test('DockerAccess rejects sensitive parent bind before returning a mutation handle', async () => {
  const { entry, data } = fixture('palworld');
  data.Mounts = [{ Type: 'bind', Source: '/var/lib/', Destination: '/data', RW: true }];
  const handles = [], calls = [];
  const access = new DockerAccess({ getContainer(id) {
    handles.push(id);
    return {
      inspect: async () => structuredClone(data),
      start: async () => { calls.push('start'); },
      stop: async () => { calls.push('stop'); }
    };
  } }, ['127.0.0.1']);
  await assert.rejects(access.inspect(entry), { code: 'IDENTITY_MISMATCH' });
  assert.deepEqual(handles, [entry.container.name]);
  assert.deepEqual(calls, []);
});
