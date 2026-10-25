// Real loopback HTTP/Ed25519 checks from SECURITY.md and docs/PHASE_9_HARDENING.md.
// No external requests or real controller/Docker capabilities are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { request as httpRequest, Agent } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { createDiscordApplication } from '../apps/discord-api/http.mjs';
import { actor, policy, deferred, until } from './phase2-harness.mjs';

const secret = 'synthetic-controller-'.repeat(3), metricsSecret = 'synthetic-metrics-'.repeat(3);
const headers = { authorization: `Bearer ${secret}`,
  'x-atlas-authorization-context': Buffer.from(JSON.stringify(actor)).toString('base64url') };
const keys = generateKeyPairSync('ed25519');
const config = { applicationId: '333333333333333333', policy: policy(),
  publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex') };

async function controller(t, overrides = {}) {
  const calls = [], service = { ready: true, instances: [{ id: 'approved', policy: policy() }], policy: policy(),
    reconcile: async () => { calls.push('health'); }, status: async () => { calls.push('status'); return { instanceId: 'approved' }; },
    monitoring: { render: () => { calls.push('metrics'); return 'atlas_controller_ready 1\n'; } },
    request: async () => { calls.push('mutation'); return { status: 202, operation: { state: 'queued' } }; }, ...overrides };
  const app = await createApplication(service, [secret], [metricsSecret]); await app.listen(0, '127.0.0.1');
  t.after(async () => { app.getHttpServer().closeAllConnections(); await app.close(); });
  return { app, base: await app.getUrl(), calls };
}

async function discord(t) {
  let calls = 0;
  const app = await createDiscordApplication({ reserve() { calls++; return 'busy'; }, autocomplete: async () => { calls++; return []; } }, config);
  await app.listen(0, '127.0.0.1');
  t.after(async () => { app.getHttpServer().closeAllConnections(); await app.close(); });
  const base = await app.getUrl();
  const post = (body, changes = {}, timestamp = String(Math.floor(Date.now() / 1000))) => fetch(`${base}/discord/interactions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': sign(null, Buffer.from(timestamp + body), keys.privateKey).toString('hex'), ...changes }, body,
  });
  return { app, base, post, calls: () => calls };
}

function raw(base, wire) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    let output = '';
    const socket = connect({ host: url.hostname, port: Number(url.port) }, () => socket.end(wire));
    socket.setEncoding('utf8'); socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('raw HTTP did not settle')); });
    socket.on('data', chunk => { output += chunk; }); socket.on('error', reject);
    socket.on('close', () => resolve(output));
  });
}

test('metrics-only token cannot read health, list, status, operations or mutate Docker', async t => {
  const h = await controller(t);
  for (const [path, method] of [['/v1/health', 'GET'], ['/v1/servers', 'GET'], ['/v1/servers/approved', 'GET'],
    ['/v1/operations/00000000-0000-4000-8000-000000000000', 'GET'], ['/v1/servers/approved/start', 'POST'], ['/v1/servers/approved/stop', 'POST']]) {
    const response = await fetch(h.base + path, { method, headers: { ...headers, authorization: `Bearer ${metricsSecret}` } });
    assert.equal(response.status, 401); assert.deepEqual(await response.json(), { code: 'UNAUTHENTICATED', message: 'UNAUTHENTICATED' });
  }
  assert.deepEqual(h.calls, []);
  const response = await fetch(h.base + '/metrics', { headers: { authorization: `Bearer ${metricsSecret}` } });
  assert.equal(response.status, 200); assert.match(await response.text(), /atlas_controller_ready 1/);
});

for (const path of ['/metrics', '/metrics?token=PRIVATE_SENTINEL', '/%6detrics', '//metrics', '/metrics/', '/METRICS']) {
  test(`service credential cannot cross separate metrics authentication at ${path}`, async t => {
    const h = await controller(t);
    const response = await fetch(h.base + path, { headers });
    assert.ok(response.status >= 400); assert.equal(h.calls.includes('metrics'), false);
    assert.doesNotMatch(await response.text(), /synthetic-|PRIVATE_SENTINEL/);
  });
}

for (const [name, framing] of [
  ['two content lengths', 'Content-Length: 2\r\nContent-Length: 2\r\n'],
  ['conflicting content lengths', 'Content-Length: 2\r\nContent-Length: 20\r\n'],
  ['chunked and content length', 'Transfer-Encoding: chunked\r\nContent-Length: 2\r\n'],
  ['obfuscated transfer encoding', 'Transfer-Encoding: chunked, identity\r\n'],
  ['invalid header name', 'Bad Header: x\r\n'],
]) test(`request-smuggling framing ${name} is rejected before service access`, async t => {
  const h = await controller(t);
  const response = await raw(h.base, `POST /v1/servers/approved/start HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${secret}\r\nContent-Type: application/json\r\n${framing}\r\n{}`);
  assert.match(response, /^HTTP\/1\.1 400 /); assert.deepEqual(h.calls, []);
  assert.doesNotMatch(response, /synthetic-|stack|HostConfig/);
});

for (const [name, framing] of [
  ['duplicate content length', 'Content-Length: 2\r\nContent-Length: 2\r\n'],
  ['length plus chunking', 'Content-Length: 2\r\nTransfer-Encoding: chunked\r\n'],
  ['invalid transfer coding', 'Transfer-Encoding: chunked, identity\r\n'],
]) test(`public Discord rejects smuggling with ${name} before signature or work handling`, async t => {
  const h = await discord(t);
  const response = await raw(h.base, `POST /discord/interactions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n${framing}\r\n{}`);
  assert.match(response, /^HTTP\/1\.1 400 /); assert.equal(h.calls(), 0);
  assert.doesNotMatch(response, /stack|HostConfig/);
});

test('duplicate authorization cannot turn an unauthenticated first header into authority', async t => {
  const h = await controller(t);
  const response = await raw(h.base, `GET /v1/health HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer invalid\r\nAuthorization: Bearer ${secret}\r\nConnection: close\r\n\r\n`);
  assert.match(response, /^HTTP\/1\.1 401 /); assert.deepEqual(h.calls, []);
});

test('32 blocked HTTP handlers retain ownership after disconnect, reject excess, then recover', async t => {
  const gate = deferred(); let entered = 0;
  const h = await controller(t, { status: async () => { entered++; await gate.promise; return { instanceId: 'approved' }; } });
  const aborters = Array.from({ length: 32 }, () => new AbortController());
  // Attach rejection handlers immediately so disconnect is never an unhandled rejection.
  const pending = aborters.map(aborter => fetch(h.base + '/v1/servers/approved', { headers, signal: aborter.signal }).then(async r => {
    await r.text(); return r.status;
  }, error => error.name));
  try {
    await until(() => entered === 32);
    const overflow = await fetch(h.base + '/v1/servers/approved', { headers });
    assert.equal(overflow.status, 429); assert.deepEqual(await overflow.json(), { code: 'RESOURCE_EXHAUSTED' });
    aborters[0].abort(); await pending[0];
    const afterDisconnect = await fetch(h.base + '/v1/servers/approved', { headers });
    assert.equal(afterDisconnect.status, 429); await afterDisconnect.text(); assert.equal(entered, 32);
  } finally { gate.resolve(); await Promise.all(pending); }
  const recovered = await fetch(h.base + '/v1/servers/approved', { headers });
  assert.equal(recovered.status, 200); await recovered.text(); assert.equal(entered, 33);
});

test('100-request keepalive ceiling retires a connection while admitting subsequent traffic', async t => {
  const h = await controller(t), agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy()); let connections = 0; h.app.getHttpServer().on('connection', () => connections++);
  const get = () => new Promise((resolve, reject) => {
    const req = httpRequest(h.base + '/v1/health', { headers: { authorization: `Bearer ${secret}` }, agent }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection }));
    }); req.on('error', reject); req.end();
  });
  for (let i = 1; i <= 101; i++) {
    const response = await get(); assert.equal(response.status, 200);
    if (i === 100) assert.equal(response.connection, 'close');
  }
  assert.equal(connections, 2);
});

for (const [name, body, change] of [
  ['unsigned', '{"type":1}', { 'x-signature-ed25519': '' }],
  ['forged', '{"type":1}', { 'x-signature-ed25519': '0'.repeat(128) }],
  ['malformed signature', '{"type":1}', { 'x-signature-ed25519': 'ff' }],
  ['malformed timestamp', '{"type":1}', { 'x-signature-timestamp': 'NaN' }],
  ['signed null', 'null', {}], ['signed array', '[]', {}], ['signed malformed JSON', '{', {}],
  ['raw NUL', '{"type":1}\0', {}], ['wrong media type', '{"type":1}', { 'content-type': 'text/plain' }],
  ['compressed media', '{"type":1}', { 'content-encoding': 'gzip' }],
]) test(`Discord ${name} cannot reserve or dispatch work`, async t => {
  const h = await discord(t), response = await h.post(body, change);
  assert.ok([400, 401].includes(response.status)); assert.equal(h.calls(), 0);
  assert.doesNotMatch(await response.text(), /stack|synthetic-|private|HostConfig/);
});

for (const offset of [-301, 301]) test(`correct signature with timestamp offset ${offset}s cannot replay`, async t => {
  const h = await discord(t), response = await h.post('{"type":1}', {}, String(Math.floor(Date.now() / 1000) + offset));
  assert.equal(response.status, 401); await response.text(); assert.equal(h.calls(), 0);
});

test('Discord raw body limit accepts exactly 64KiB and rejects one extra signed byte', async t => {
  const h = await discord(t), small = '{"type":1,"padding":""}';
  const body = JSON.stringify({ type: 1, padding: 'x'.repeat(65536 - Buffer.byteLength(small)) });
  assert.equal(Buffer.byteLength(body), 65536);
  const accepted = await h.post(body); assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { type: 1 });
  const rejected = await h.post(body + ' '); assert.equal(rejected.status, 400); await rejected.text(); assert.equal(h.calls(), 0);
});

test('Discord rejects signed 64KiB-plus-one payload independently of PING response status', async t => {
  const h = await discord(t), small = '{"type":1,"padding":""}';
  const body = JSON.stringify({ type: 1, padding: 'x'.repeat(65537 - Buffer.byteLength(small)) });
  assert.equal(Buffer.byteLength(body), 65537);
  const response = await h.post(body); assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { code: 'INVALID_REQUEST' }); assert.equal(h.calls(), 0);
});

test('SLOWLORIS: public request body deadline closes an incomplete request within 12 seconds', { timeout: 15000 }, async t => {
  const h = await discord(t), url = new URL(h.base);
  const socket = connect({ host: url.hostname, port: Number(url.port) });
  let socketError; socket.on('error', error => { socketError = error; }); socket.resume();
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  const closed = new Promise(resolve => socket.once('close', () => resolve(true)));
  socket.write('POST /discord/interactions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 10\r\n\r\n{');
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve(false), 12000); });
  try {
    assert.equal(await Promise.race([closed, expired]), true, 'documented 10s body deadline was not enforced with 2s scheduling allowance');
    assert.equal(h.calls(), 0); assert.ok(!socketError || ['ECONNRESET', 'EPIPE'].includes(socketError.code));
  } finally { clearTimeout(timer); socket.destroy(); }
});
