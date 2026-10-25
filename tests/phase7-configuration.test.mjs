import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRegistry } from '../libs/server-registry/index.mjs';
import { verifyIdentity } from '../apps/docker-controller/docker.mjs';
import { validateBackupConfig } from '../apps/backup-worker/worker.mjs';

const read = (game, file) => JSON.parse(readFileSync(new URL(`../infrastructure/games/${game}/${file}`, import.meta.url)));
const games = ['vrising', 'zomboid', 'palworld'];
test('Phase 7 backup overlay mounts the matching persistent volumes read-only', () => {
  const config = JSON.parse(readFileSync(new URL('../infrastructure/backup/phase7.settings.example.json', import.meta.url)));
  const overlay = JSON.parse(readFileSync(new URL('../infrastructure/backup/phase7.override.json', import.meta.url)));
  validateBackupConfig(config, games.map(game => read(game, 'instance.example.json')));
  for (const game of games) {
    const entry = read(game, 'instance.example.json'), stack = read(game, 'compose.json');
    const job = config.jobs.find(j => j.instanceId === entry.id);
    const mount = overlay.services['backup-worker'].volumes.find(m => m.target === job.source);
    assert.equal(mount.read_only, true);
    assert.equal(overlay.volumes[mount.source].external, true);
    assert.equal(overlay.volumes[mount.source].name.split(':?')[0], stack.volumes.world.name.split(':?')[0]);
    assert.equal(job.containerPath, stack.services[game].volumes[0].target);
    assert.equal(job.allowRetentionDeletion, false);
  }
});
test('all four game manifests coexist without ownership or native port conflicts', () => {
  assert.equal(validateRegistry(['minecraft', ...games].map(game => read(game, 'instance.example.json'))).length, 4);
});
for (const game of games) test(`${game}: isolated persistent stack matches runtime identity and rejects extra administration exposure`, () => {
  const stack = read(game, 'compose.json'), entry = validateRegistry([read(game, 'instance.example.json')])[0];
  const service = stack.services[game];
  assert.equal(service.container_name, entry.container.name);
  assert.deepEqual(service.labels, entry.container.requiredLabels);
  assert.equal(service.restart, 'no');
  assert.equal(service.pull_policy, 'never');
  assert.equal(service.platform, 'linux/amd64');
  assert.deepEqual(service.networks, ['game']);
  assert.equal(stack.networks.game.name, `atlas-game-${entry.id}`);
  assert.equal(service.user, '1000:1000');
  assert.deepEqual(service.cap_drop, ['ALL']);
  assert.deepEqual(service.security_opt, ['no-new-privileges:true']);
  assert.equal(service.stop_signal, 'SIGTERM');
  assert.equal(service.stop_grace_period, '120s');
  assert.match(service.image, /:\?/);
  assert.match(service.mem_limit, /:\?/);
  assert.match(service.cpus, /:\?/);
  assert.deepEqual(service.ports.map(p => ({ hostPort: Number(p.published), containerPort: p.target, protocol: p.protocol })), entry.container.publishedPorts);
  for (const p of service.ports) assert.match(p.host_ip, /:\?/);
  for (const mount of service.volumes) {
    assert.equal(mount.type, 'volume');
    assert.equal(stack.volumes[mount.source].external, true);
    assert.match(stack.volumes[mount.source].name, /:\?/);
  }
  assert.deepEqual(entry.adapter, { lifecycle: 'generic', readiness: 'unverified', stop: 'docker-stop', backup: 'stopped-volume' });
  for (const name of ['allowedDiscordGuilds', 'allowedDiscordUsers', 'allowedDiscordRoles']) assert.deepEqual(entry.policy[name], []);
  const data = { Id: `mock-${game}`, Name: `/${entry.container.name}`, Config: { User: service.user, Labels: service.labels },
    HostConfig: { CapDrop: service.cap_drop, SecurityOpt: service.security_opt, RestartPolicy: { Name: service.restart }, Memory: entry.resources.hardMemoryMiB * 1048576,
      PortBindings: Object.fromEntries(service.ports.map(p => [`${p.target}/${p.protocol}`, [{ HostIp: '127.0.0.1', HostPort: p.published }]])) },
    NetworkSettings: { Networks: { [stack.networks.game.name]: {} } } };
  assert.doesNotThrow(() => verifyIdentity(entry, data, ['127.0.0.1']));
  const exposed = structuredClone(data); exposed.HostConfig.PortBindings['8212/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '8212' }];
  assert.throws(() => verifyIdentity(entry, exposed, ['127.0.0.1']), /PORT_MISMATCH/);
  const root = structuredClone(data); root.Config.User = '0:0';
  assert.throws(() => verifyIdentity(entry, root, ['127.0.0.1']), /IDENTITY_MISMATCH/);
});
