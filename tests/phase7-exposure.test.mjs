import test from 'node:test';
import assert from 'node:assert/strict';
import { games, fixture } from './phase7-harness.mjs';

for (const game of games) {
  test(`${game}: no host namespaces, devices, privilege grants or management routing in candidate`, () => {
    const { service, stack } = fixture(game);
    for (const key of ['privileged', 'devices', 'device_cgroup_rules', 'cap_add', 'pid', 'ipc', 'uts',
      'network_mode', 'use_api_socket', 'volumes_from', 'external_links', 'links', 'post_start', 'pre_stop']) {
      assert.equal(service[key], undefined, key);
    }
    assert.deepEqual(Object.keys(stack.services), [game]);
    assert.deepEqual(Object.keys(stack.networks), ['game']);
    assert.equal(stack.networks.game.external, undefined);
    assert.ok(Object.keys(service.labels).every(label => label.startsWith('io.atlasdominion.')));
  });
  test(`${game}: all published ports are UDP gameplay ports, administration stays internal`, () => {
    const { service } = fixture(game);
    assert.equal(service.expose, undefined);
    for (const port of service.ports) {
      assert.equal(port.protocol, 'udp');
      assert.ok(![8212, 25575, 27020, 2375, 2376, 9090, 3000].includes(Number(port.published)));
      assert.equal(port.mode, undefined);
    }
  });
  test(`${game}: external world volumes never alias installation volume placeholders`, () => {
    const { service, stack } = fixture(game);
    const sources = service.volumes.map(v => stack.volumes[v.source].name);
    assert.equal(new Set(sources).size, sources.length);
    assert.equal(service.volumes.filter(v => v.source === 'world').length, 1);
    assert.ok(service.volumes.every(v => v.type === 'volume' && !v.read_only));
  });
  test(`${game}: process and log growth are bounded independently of admission budgets`, () => {
    const { service } = fixture(game);
    assert.ok(Number.isSafeInteger(service.pids_limit) && service.pids_limit > 0);
    assert.equal(service.logging.driver, 'local');
    assert.match(service.logging.options['max-size'], /^[1-9][0-9]*m$/);
    assert.ok(Number(service.logging.options['max-file']) > 0);
  });
}
test('Palworld automatic lifecycle owners remain disabled with private administration enabled for save wrapper', () => {
  const { service } = fixture('palworld');
  for (const name of ['UPDATE_ON_BOOT', 'AUTO_UPDATE_ENABLED', 'AUTO_REBOOT_ENABLED', 'BACKUP_ENABLED', 'AUTO_PAUSE_ENABLED', 'AUTO_SLEEP_ENABLED'])
    assert.equal(service.environment[name], 'false', name);
  for (const name of ['ADMIN_PASSWORD', 'SERVER_PASSWORD']) assert.match(service.environment[name], /:\?/);
  assert.equal(service.environment.COMMUNITY, 'false');
});
