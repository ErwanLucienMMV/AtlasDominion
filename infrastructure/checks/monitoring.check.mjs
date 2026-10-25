// Compose config only: does not contact the daemon or create resources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const env = { ...process.env,
  PROMETHEUS_IMAGE: 'local/prometheus:validation', GRAFANA_IMAGE: 'local/grafana:validation', NODE_EXPORTER_IMAGE: 'local/node-exporter:validation',
  METRICS_RETENTION: '7d', METRICS_RETENTION_SIZE: '1GB', PROMETHEUS_DATA_VOLUME: 'test-metrics', GRAFANA_DATA_VOLUME: 'test-grafana',
  CONTROLLER_SECRET_FILE: `${root}/package.json`, GRAFANA_PASSWORD_FILE: `${root}/package.json`, METRICS_SECRET_FILE: `${root}/package.json`,
  GRAFANA_ADMIN_USER: 'test-operator', GRAFANA_ROOT_URL: 'https://test.invalid/',
  DISCORD_API_IMAGE: 'local/discord:validation', CONTROLLER_IMAGE: 'local/controller:validation',
  REGISTRY_DIRECTORY: root, CONTROLLER_CONFIG_FILE: `${root}/package.json`, CONTROLLER_AUDIT_VOLUME: 'test-audit' };
function config(files) {
  const result = spawnSync('docker', ['compose', ...files.flatMap(f => ['-f', f]), 'config', '--format', 'json'], { cwd: root, env, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
test('Compose accepts private monitoring stack with explicit secrets and retained data', () => {
  const rendered = config(['infrastructure/monitoring/compose.json']);
  for (const service of Object.values(rendered.services)) assert.equal(service.ports, undefined);
  assert.equal(rendered.services.grafana.environment.GF_AUTH_ANONYMOUS_ENABLED, 'false');
  assert.equal(rendered.volumes.metrics.external, true);
});
test('controller monitoring override merges without losing socket, registry or control networking', () => {
  const rendered = config(['infrastructure/applications/compose.json', 'infrastructure/monitoring/controller.override.json']);
  const controller = rendered.services['docker-controller'];
  assert.deepEqual(controller.volumes.map(v => v.target).sort(), ['/audit', '/etc/atlas/controller.json', '/registry', '/var/run/docker.sock']);
  assert.equal(controller.ports, undefined);
  assert.ok(controller.networks.control); assert.ok(controller.networks.monitoring);
  assert.equal(controller.networks.proxy, undefined);
});
