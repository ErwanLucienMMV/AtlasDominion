import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env, BACKUP_IMAGE: 'local/backup:validation', BACKUP_UID: '1000', BACKUP_GID: '1000', DOCKER_SOCKET_GID: '999',
  BACKUP_CONFIG_FILE: `${root}/package.json`, REGISTRY_DIRECTORY: root, BACKUP_DIRECTORY: root, BACKUP_LOCK_DIRECTORY: root,
  MINECRAFT_DATA_VOLUME: 'validation-world', DISCORD_API_IMAGE: 'local/discord:validation', CONTROLLER_IMAGE: 'local/controller:validation', CONTROLLER_SECRET_FILE: `${root}/package.json` };
function render(files) {
  const result = spawnSync('docker', ['compose', ...files.flatMap(f => ['-f', f]), 'config', '--format', 'json'], { cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test('backup Compose has no network, ports or writable world mount', () => {
  const config = render(['infrastructure/backup/compose.json']), worker = config.services['backup-worker'];
  assert.equal(worker.network_mode, 'none'); assert.equal(worker.ports, undefined); assert.equal(worker.read_only, true);
  assert.equal(worker.volumes.find(v => v.target === '/sources/minecraft-survival').read_only, true);
  assert.equal(config.volumes.world.external, true);
});
test('backup controller override preserves existing controller mounts', () => {
  const config = render(['infrastructure/applications/compose.json', 'infrastructure/backup/controller.override.json']);
  assert.deepEqual(config.services['docker-controller'].volumes.map(v => v.target).sort(), ['/locks', '/registry', '/var/run/docker.sock']);
  assert.equal(config.services['docker-controller'].ports, undefined);
});
