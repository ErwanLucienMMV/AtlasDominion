import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderInfrastructure, writeInfrastructure } from '../libs/infrastructure/index.mjs';

const settings = { hostname: 'atlas-test.duckdns.org', acmeEmail: 'test@example.com', acmeChallenge: 'http-01', certificateAuthority: 'staging', traefikImage: 'traefik:v3.7.15', accessLogs: 'disabled' };

test('edge publishes only web ports, uses File Provider only and has no privileged mounts', () => {
  const { compose, staticConfig, dynamicConfig } = renderInfrastructure(settings);
  const edge = compose.services.traefik;
  assert.deepEqual(edge.ports, ['80:80/tcp', '443:443/tcp']);
  assert.deepEqual(edge.networks, ['proxy', 'egress']);
  assert.deepEqual(Object.keys(staticConfig.providers), ['file']);
  assert.equal(staticConfig.providers.file.watch, true);
  assert.equal(staticConfig.api, undefined);
  assert.equal(staticConfig.accessLog, undefined);
  assert.equal(edge.pull_policy, 'never');
  assert.equal(edge.read_only, true);
  assert.ok(edge.volumes.every(v => !/sock|registry|secrets/.test(v.source)));
  assert.equal(dynamicConfig.tcp, undefined);
  assert.equal(dynamicConfig.udp, undefined);
  assert.deepEqual(Object.keys(dynamicConfig.http.routers), ['discord-interactions']);
  const route = dynamicConfig.http.routers['discord-interactions'];
  assert.equal(route.rule, 'Host(`atlas-test.duckdns.org`) && Path(`/discord/interactions`) && Method(`POST`)');
  assert.deepEqual(route.entryPoints, ['websecure']);
  assert.equal(route.tls.certResolver, 'letsencrypt');
  assert.equal(dynamicConfig.http.middlewares['strip-internal-context'].headers.customRequestHeaders['X-Atlas-Authorization-Context'], '');
  assert.equal(dynamicConfig.http.middlewares['bounded-body'].buffering.maxRequestBodyBytes, 16384);
});

test('ACME challenges are explicit and staging cannot silently issue production certificates', () => {
  const { staticConfig } = renderInfrastructure(settings);
  const acme = staticConfig.certificatesResolvers.letsencrypt.acme;
  assert.match(acme.caServer, /acme-staging/);
  assert.deepEqual(acme.httpChallenge, { entryPoint: 'web' });
  assert.equal(acme.storage, '/state/acme.json');
  assert.equal(staticConfig.entryPoints.web.http.redirections.entryPoint.scheme, 'https');
  const prod = renderInfrastructure({ ...settings, acmeChallenge: 'tls-alpn-01', certificateAuthority: 'production' }).staticConfig;
  assert.deepEqual(prod.certificatesResolvers.letsencrypt.acme.tlsChallenge, {});
  assert.equal(prod.certificatesResolvers.letsencrypt.acme.httpChallenge, undefined);
  assert.equal(prod.certificatesResolvers.letsencrypt.acme.caServer, 'https://acme-v02.api.letsencrypt.org/directory');
});

test('optional access logging allows only bounded operational fields', () => {
  const { staticConfig } = renderInfrastructure({ ...settings, accessLogs: 'sanitized' });
  assert.deepEqual(staticConfig.accessLog.fields, {
    defaultMode: 'drop', names: { StartUTC: 'keep', Duration: 'keep', DownstreamStatus: 'keep', RouterName: 'keep' }, headers: { defaultMode: 'drop' }
  });
});

for (const [name, patch] of Object.entries({
  'router injection': { hostname: 'x.org`) || PathPrefix(`/`)' },
  'URL instead of hostname': { hostname: 'https://atlas.org' },
  'uppercase hostname': { hostname: 'Atlas.org' },
  'bad email': { acmeEmail: 'private\nvalue' },
  'floating image': { traefikImage: 'traefik:latest' },
  'unpinned minor': { traefikImage: 'traefik:v3.7' },
  'foreign image': { traefikImage: 'untrusted:v3.7.15' },
  'unreviewed ACME': { acmeChallenge: 'dns-01' },
  'implicit authority': { certificateAuthority: undefined },
  'unredacted logs': { accessLogs: 'all' },
  'arbitrary path': { socket: '/var/run/docker.sock' }
})) test(`configuration rejects ${name}`, () => assert.throws(() => renderInfrastructure({ ...settings, ...patch })));

test('writer refuses any existing output and preserves existing certificate state', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'atlas-infra-'));
  const output = join(parent, 'rendered');
  await writeInfrastructure(settings, output);
  assert.deepEqual(JSON.parse(await readFile(join(output, 'compose.json'), 'utf8')), renderInfrastructure(settings).compose);
  await writeFile(join(output, 'state/acme.json'), 'existing certificate sentinel');
  await assert.rejects(writeInfrastructure(settings, output), { code: 'EEXIST' });
  assert.equal(await readFile(join(output, 'state/acme.json'), 'utf8'), 'existing certificate sentinel');
  if (process.platform !== 'win32') assert.equal((await stat(join(output, 'state/acme.json'))).mode & 0o777, 0o600);
  const invalid = join(parent, 'invalid');
  await assert.rejects(writeInfrastructure({ ...settings, hostname: 'bad' }, invalid));
  await assert.rejects(stat(invalid), { code: 'ENOENT' });
  await mkdir(join(parent, 'existing'));
  await assert.rejects(writeInfrastructure(settings, join(parent, 'existing')), { code: 'EEXIST' });
});
