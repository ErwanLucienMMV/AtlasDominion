import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/render-infrastructure.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'atlas-render-cli-'));
function run(args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.ifError(result.error);
  return result;
}

test('renderer CLI has sanitized errors for invalid settings and paths', () => {
  const marker = 'SECRET-DO-NOT-PRINT';
  const input = join(scratch, 'bad.json');
  writeFileSync(input, JSON.stringify({ token: marker }));
  for (const args of [[], [input, join(scratch, 'output')], [join(scratch, marker), join(scratch, 'missing')]]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET-DO-NOT-PRINT|\n\s+at /);
  }
});

test('renderer CLI produces configuration and refuses a second write', () => {
  const input = join(scratch, 'settings.json');
  writeFileSync(input, JSON.stringify({ hostname: 'acceptance.duckdns.org', acmeEmail: 'operator@example.com', acmeChallenge: 'tls-alpn-01', certificateAuthority: 'staging', traefikImage: 'traefik:v3.7.15', accessLogs: 'disabled' }));
  const output = join(scratch, 'valid');
  assert.equal(run([input, output]).status, 0);
  const before = readFileSync(join(output, 'compose.json'), 'utf8');
  assert.equal(run([input, output]).status, 1);
  assert.equal(readFileSync(join(output, 'compose.json'), 'utf8'), before);
  const dynamic = JSON.parse(readFileSync(join(output, 'dynamic/routes.yml'), 'utf8'));
  assert.equal(Object.keys(dynamic.http.routers).length, 1);
  assert.equal(dynamic.http.services['discord-api'].loadBalancer.servers[0].url, 'http://atlas-discord-api:3000');
});
