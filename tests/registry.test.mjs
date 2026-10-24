import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRegistry, resolveInstance } from '../libs/server-registry/index.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/instance.json', import.meta.url), 'utf8'));
function instance(i = 0) {
  const entry = structuredClone(fixture);
  entry.id = `server-${i}`;
  entry.container.name = `game-${i}`;
  entry.container.requiredLabels['io.atlasdominion.instance'] = entry.id;
  entry.container.publishedPorts[0].hostPort = 25000 + i;
  return entry;
}

test('multiple instances per game and 50 arbitrary game types need only configuration', () => {
  const entries = Array.from({ length: 50 }, (_, i) => instance(i));
  assert.equal(validateRegistry(entries).length, 50);
  entries.forEach((entry, i) => { entry.gameType = `unknown-game-${i}`; });
  assert.equal(validateRegistry(entries).length, 50);
  assert.equal(resolveInstance(entries, 'server-49').id, 'server-49');
});

for (const [name, mutate] of Object.entries({
  'unknown schema': e => { e.schemaVersion = 2; },
  'missing field': e => { delete e.policy; },
  'invalid id': e => { e.id = '../bad'; },
  'unknown adapter': e => { e.adapter.lifecycle = 'download-script'; },
  'unknown readiness': e => { e.adapter.readiness = 'minecraft-protocol'; },
  'label mismatch': e => { e.container.requiredLabels['io.atlasdominion.instance'] = 'other'; },
  'spoofed managed label': e => { e.container.requiredLabels['io.atlasdominion.managed'] = 'false'; },
  'invalid port': e => { e.container.publishedPorts[0].hostPort = 65536; },
  'fractional port': e => { e.container.publishedPorts[0].hostPort = 1.5; },
  'invalid protocol': e => { e.container.publishedPorts[0].protocol = 'http'; },
  'arbitrary command': e => { e.command = 'sh'; },
  'arbitrary mount': e => { e.container.hostPath = '/'; },
  'invalid resource': e => { e.resources.admissionCpuUnits = 0; },
  'invalid Discord id': e => { e.policy.allowedDiscordUsers = ['anyone']; },
  'automatic restart': e => { e.policy.allowAutoRestart = true; },
  'admin-only stop': e => { e.policy.stopRequiresAdmin = true; }
})) test(`rejects ${name}`, () => {
  const entry = instance(); mutate(entry);
  assert.throws(() => validateRegistry([entry]));
});

test('rejects duplicate IDs, ownership and port conflicts', () => {
  for (const mutate of [e => { e.id = 'server-0'; e.container.requiredLabels['io.atlasdominion.instance'] = e.id; },
    e => { e.container.name = 'game-0'; }, e => { e.container.publishedPorts[0].hostPort = 25000; }]) {
    const second = instance(1); mutate(second);
    assert.throws(() => validateRegistry([instance(), second]));
  }
});
test('TCP and UDP may share a port; unknown instance fails closed', () => {
  const second = instance(1);
  second.container.publishedPorts[0] = { hostPort: 25000, containerPort: 25000, protocol: 'udp' };
  assert.equal(validateRegistry([instance(), second]).length, 2);
  assert.throws(() => resolveInstance([instance()], 'unregistered'));
  assert.throws(() => validateRegistry(null));
});
