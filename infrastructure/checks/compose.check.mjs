// Explicit Docker Compose CLI checks: no daemon, pull, create, up or teardown.
// Named .check.mjs so dependency-free npm test does not require Docker installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeInfrastructure } from '../../libs/infrastructure/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'atlas-compose-check-'));
const settings = { hostname: 'atlas-test.duckdns.org', acmeEmail: 'test@example.com', traefikImage: 'traefik:v3.7.15' };
const variables = {
  DISCORD_API_IMAGE: 'local/discord-api:validation', CONTROLLER_IMAGE: 'local/controller:validation',
  REGISTRY_DIRECTORY: join(scratch, 'registry'), CONTROLLER_SECRET_FILE: join(scratch, 'secret'),
  INSTANCE_ID: 'fixture-one', GAME_IMAGE: 'local/game:validation', GAME_CONTAINER_NAME: 'game-fixture-one',
  GAME_MEMORY_LIMIT: '256m', GAME_CPU_LIMIT: '0.5', GAME_PIDS_LIMIT: '64', GAME_STOP_GRACE_PERIOD: '30s',
  GAME_CONTAINER_PORT: '25565', GAME_HOST_PORT: '25565', GAME_BIND_ADDRESS: '127.0.0.1', GAME_PORT_PROTOCOL: 'tcp',
  GAME_DATA_VOLUME: 'fixture-world', GAME_DATA_TARGET: '/data'
};
writeFileSync(variables.CONTROLLER_SECRET_FILE, 'test-only-not-a-production-secret');

function compose(file, env = variables, expectSuccess = true) {
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(variables)) delete cleanEnv[key];
  const result = spawnSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], {
    cwd: root, env: { ...cleanEnv, ...env }, encoding: 'utf8', timeout: 30000, windowsHide: true
  });
  assert.ifError(result.error);
  if (!expectSuccess) { assert.notEqual(result.status, 0); return; }
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

for (const acmeChallenge of ['http-01', 'tls-alpn-01']) for (const accessLogs of ['disabled', 'sanitized']) {
  test(`Compose accepts generated ${acmeChallenge}/${accessLogs} edge`, async () => {
    const output = join(scratch, `${acmeChallenge}-${accessLogs}`);
    await writeInfrastructure({ ...settings, acmeChallenge, accessLogs, certificateAuthority: 'staging' }, output);
    const result = compose(join(output, 'compose.json'));
    assert.deepEqual(result.services.traefik.ports.map(p => p.published).sort(), ['443', '80']);
    assert.equal(result.networks.proxy.external, true);
    assert.equal(result.services.traefik.networks.control, undefined);
    assert.equal(result.services.traefik.volumes.filter(v => !v.read_only).length, accessLogs === 'sanitized' ? 2 : 1);
  });
}

test('application Compose preserves private controller and socket boundary', () => {
  const { services, networks } = compose('infrastructure/applications/compose.json');
  for (const service of Object.values(services)) assert.equal(service.ports, undefined);
  assert.equal(services['docker-controller'].networks.proxy, undefined);
  assert.equal(services['docker-controller'].networks.egress, undefined);
  assert.ok(services['docker-controller'].networks.control);
  assert.ok(services['docker-controller'].networks.monitoring);
  assert.ok(services['discord-api'].networks.egress);
  assert.equal(services['discord-api'].volumes, undefined);
  assert.equal(services['docker-controller'].volumes.filter(v => v.target === '/var/run/docker.sock').length, 1);
  for (const name of ['proxy', 'control', 'monitoring']) assert.equal(networks[name].external, true);
});

test('independent game projects preserve identity, native TCP/UDP ports and external data', () => {
  for (const protocol of ['tcp', 'udp']) {
    const a = compose('infrastructure/games/compose.template.json', { ...variables, GAME_PORT_PROTOCOL: protocol });
    const b = compose('infrastructure/games/compose.template.json', { ...variables, INSTANCE_ID: 'fixture-two', GAME_CONTAINER_NAME: 'game-fixture-two', GAME_DATA_VOLUME: 'fixture-two-world', GAME_HOST_PORT: '25566' });
    assert.notEqual(a.name, b.name);
    assert.notEqual(a.networks.game.name, b.networks.game.name);
    assert.notEqual(a.volumes.world.name, b.volumes.world.name);
    const game = a.services.game;
    assert.equal(game.restart, 'no');
    assert.equal(game.pull_policy, 'never');
    assert.equal(game.labels['io.atlasdominion.instance'], variables.INSTANCE_ID);
    assert.equal(game.ports[0].protocol, protocol);
    assert.equal(game.ports[0].host_ip, '127.0.0.1');
    assert.deepEqual(Object.keys(game.networks), ['game']);
    assert.equal(a.volumes.world.external, true);
    assert.ok(game.mem_limit > 0 && game.cpus > 0 && game.pids_limit > 0);
  }
});

test('every required stack variable fails closed when omitted', () => {
  for (const file of ['infrastructure/applications/compose.json', 'infrastructure/games/compose.template.json']) {
    const template = readFileSync(join(root, file), 'utf8');
    const required = [...new Set([...template.matchAll(/\$\{([A-Z_]+):\?/g)].map(m => m[1]))];
    for (const key of required) {
      const env = { ...variables };
      delete env[key];
      compose(file, env, false);
    }
  }
});
