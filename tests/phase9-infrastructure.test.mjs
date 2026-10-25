import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderInfrastructure } from '../libs/infrastructure/index.mjs';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));

test('every infrastructure service has bounded resources and preserves privilege boundaries', () => {
  const edge = renderInfrastructure({ hostname: 'atlas.example.org', acmeEmail: 'ops@example.org', acmeChallenge: 'http-01', certificateAuthority: 'staging', traefikImage: 'traefik:v3.7.15', accessLogs: 'disabled' }).compose;
  for (const stack of [edge, json('infrastructure/applications/compose.json'), json('infrastructure/monitoring/compose.json'), json('infrastructure/backup/compose.json')]) {
    for (const [name, service] of Object.entries(stack.services)) {
      assert.match(service.mem_limit, /^[1-9][0-9]*m$/, name);
      assert.ok(Number(service.cpus) > 0, name); assert.ok(service.pids_limit > 0, name);
      assert.equal(service.restart, 'unless-stopped'); assert.equal(service.read_only, true);
      assert.equal(service.privileged, undefined); assert.ok(service.cap_drop.includes('ALL'));
      assert.ok(service.security_opt.includes('no-new-privileges:true'));
      const socket = service.volumes?.filter(v => v.target === '/var/run/docker.sock') ?? [];
      if (['docker-controller', 'backup-worker'].includes(name)) assert.equal(socket.length, 1);
      else assert.equal(socket.length, 0);
      if (name !== 'traefik') assert.equal(service.ports, undefined);
    }
  }
});

test('CI runs full tests, all Compose stacks and semantic alert verification without deployment', () => {
  const workflow = read('.github/workflows/ci.yml');
  for (const command of ['npm ci', 'npm test', 'npm run check:production', 'promtool check rules', 'promtool test rules', 'git diff --check']) assert.ok(workflow.includes(command), command);
  assert.doesNotMatch(workflow, /continue-on-error|docker compose up|docker compose down|pull_request_target/);
  assert.match(workflow, /contents: read/);
  assert.deepEqual(json('package.json').scripts['check:production'].match(/infrastructure\/checks\/[a-z]+\.check\.mjs/g).sort(), [
    'infrastructure/checks/backup.check.mjs', 'infrastructure/checks/compose.check.mjs', 'infrastructure/checks/monitoring.check.mjs'
  ]);
});
