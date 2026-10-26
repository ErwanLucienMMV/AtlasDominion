import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyIdentity } from '../apps/docker-controller/docker.mjs';
import { validateRegistry } from '../libs/server-registry/index.mjs';
import { fixture } from './phase7-harness.mjs';

test('CPU quota and period are an accepted finite ceiling without NanoCpus', () => {
  const { entry, data } = fixture('palworld');
  Object.assign(data.HostConfig, { NanoCpus: 0, CpuQuota: 200000, CpuPeriod: 100000 });
  assert.doesNotThrow(() => verifyIdentity(entry, data, ['127.0.0.1']));
});

for (const value of [0, -1, NaN, Infinity, '1024', null]) test(`invalid PID ceiling ${String(value)} fails closed`, () => {
  const { entry, data } = fixture('palworld');
  data.HostConfig.PidsLimit = value;
  assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']), { code: 'IDENTITY_MISMATCH' });
});

for (const field of ['NetworkSettings', 'NetworkMode', 'User']) test(`incomplete ${field} evidence fails closed`, () => {
  const { entry, data } = fixture('palworld');
  if (field === 'NetworkSettings') delete data.NetworkSettings;
  else if (field === 'NetworkMode') delete data.HostConfig.NetworkMode;
  else delete data.Config.User;
  assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']), { code: 'IDENTITY_MISMATCH' });
});

test('reviewed custom network approvals match the entire attachment set', () => {
  const { entry, data } = fixture('palworld');
  entry.container.allowedNetworks = ['reviewed-world', 'reviewed-downloads'];
  assert.equal(validateRegistry([entry]).length, 1);
  data.HostConfig.NetworkMode = 'reviewed-world';
  data.NetworkSettings.Networks = { 'reviewed-world': {}, 'reviewed-downloads': {} };
  assert.doesNotThrow(() => verifyIdentity(entry, data, ['127.0.0.1']));
  data.NetworkSettings.Networks.foreign = {};
  assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']), { code: 'IDENTITY_MISMATCH' });
  delete data.NetworkSettings.Networks.foreign;
  delete data.NetworkSettings.Networks['reviewed-downloads'];
  assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']), { code: 'IDENTITY_MISMATCH' });
});

for (const networks of [[], ['bridge'], ['none'], ['host'], ['default'], ['atlas-control'], ['atlas-monitoring'], ['proxy'], ['reviewed', 'reviewed']]) {
  test(`registry refuses unsafe network approval ${JSON.stringify(networks)}`, () => {
    const { entry } = fixture('palworld');
    entry.container.allowedNetworks = networks;
    assert.throws(() => validateRegistry([entry]));
  });
}
