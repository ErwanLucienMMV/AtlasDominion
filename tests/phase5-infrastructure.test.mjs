import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = path => readFileSync(new URL(`../infrastructure/monitoring/${path}`, import.meta.url), 'utf8');
const stack = JSON.parse(read('compose.json'));
test('monitoring remains private, persistent and independent of game stacks', () => {
  assert.deepEqual(Object.keys(stack.services).sort(), ['grafana', 'node-exporter', 'prometheus']);
  for (const service of Object.values(stack.services)) {
    assert.equal(service.ports, undefined); assert.equal(service.privileged, undefined);
    assert.equal(service.pull_policy, 'never'); assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ['ALL']);
    assert.ok(!JSON.stringify(service).includes('docker.sock'));
    assert.match(service.image, /:\?/);
  }
  assert.equal(stack.services.prometheus.networks.proxy, undefined);
  assert.equal(stack.services['node-exporter'].networks.proxy, undefined);
  assert.equal(stack.services.grafana.environment.GF_AUTH_ANONYMOUS_ENABLED, 'false');
  assert.equal(stack.services.grafana.environment.GF_USERS_ALLOW_SIGN_UP, 'false');
  assert.equal(stack.services.grafana.environment.GF_SECURITY_COOKIE_SECURE, 'true');
  assert.ok(stack.services.grafana.environment.GF_SECURITY_ADMIN_PASSWORD__FILE);
  for (const volume of Object.values(stack.volumes)) assert.equal(volume.external, true);
  assert.ok(stack.services.prometheus.command.some(c => c.includes('retention.size')));
});
test('controller override preserves existing mounts and adds durable audit/config wiring', () => {
  const override = JSON.parse(read('controller.override.json'));
  const controller = override.services['docker-controller'];
  assert.equal(controller.environment.CONTROLLER_CONFIG_FILE, '/etc/atlas/controller.json');
  assert.ok(controller.volumes.some(v => v.target === '/audit' && v.type === 'volume'));
  assert.equal(override.volumes['controller-audit'].external, true);
});
test('discovery and dashboards use stable instance labels without game-specific selectors', () => {
  const dashboard = JSON.parse(read('grafana/dashboards/instances.json'));
  assert.match(dashboard.templating.list[0].query, /label_values\(atlas_instance_info, instance\)/);
  assert.equal(dashboard.templating.list[0].includeAll, true);
  for (const title of ['Admission', 'Measured host', 'Measured game', 'Lifecycle', 'Controller', 'Unexpected'])
    assert.ok(dashboard.panels.some(p => p.title.startsWith(title)));
  const config = read('prometheus.yml');
  assert.match(config, /credentials_file: \/run\/secrets\/metrics-token/);
  assert.match(config, /honor_labels: true/);
  assert.ok(!config.includes('minecraft'));
  assert.match(read('alerts.yml'), /atlas_instance_wanted_running == 1/);
  assert.match(read('alerts.yml'), /HostMemoryPressure/);
  assert.match(read('alerts.yml'), /AdmissionBudgetPressure/);
  assert.match(read('alerts.yml'), /alert: ResourceSamplingDegraded\s+expr: atlas_resource_sampling_ready == 0 or time\(\) - atlas_resource_sampling_timestamp_seconds > 90\s+for: 1m/);
  for (const expr of ['atlas_resource_sampling_ready', 'time() - atlas_resource_sampling_timestamp_seconds'])
    assert.ok(dashboard.panels.some(panel => panel.targets.some(target => target.expr === expr)));
  const route = JSON.parse(read('grafana-route.example.json'));
  assert.deepEqual(route.http.routers.grafana.entryPoints, ['websecure']);
  assert.equal(route.http.routers.grafana.tls.certResolver, 'letsencrypt');
});
