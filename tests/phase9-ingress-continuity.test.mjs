// Requirements: SECURITY.md and PHASE_9_HARDENING.md. Real loopback HTTP,
// disposable Ed25519 keypair, fake services; no Discord or Docker connection.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { createDiscordApplication } from '../apps/discord-api/http.mjs';
import { signed } from '../apps/discord-api/security.mjs';
import { actor, policy } from './phase2-harness.mjs';

const keys = generateKeyPairSync('ed25519'), secret = 's'.repeat(64), metrics = 'm'.repeat(64);
const config = { applicationId: '333333333333333333', policy: policy(),
  publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
function signature(body, timestamp = String(Math.floor(Date.now() / 1000))) {
  return { 'x-signature-timestamp': timestamp,
    'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(body)]), keys.privateKey).toString('hex') };
}
function wire(base, bytes) {
  const url = new URL(base);
  return new Promise((resolve, reject) => {
    const socket = connect(Number(url.port), url.hostname);
    let output = '';
    socket.setEncoding('utf8'); socket.on('data', data => { output += data; });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Loopback response deadline')); }, 4000);
    socket.once('connect', () => socket.write(bytes)); socket.once('error', reject);
    socket.once('close', () => { clearTimeout(timer); resolve(output); });
  });
}
const headerLines = values => Object.entries(values).map(([key, value]) => `${key}: ${value}\r\n`).join('');

test('public signatures retain byte identity at exact clock boundaries', async t => {
  const body = Buffer.from('{ "type": 1, "text": "é 世界" }'), timestamp = '1793016000';
  const headers = signature(body, timestamp), center = Number(timestamp) * 1000;
  for (const offset of [-300001, -300000, -299999, 0, 299999, 300000, 300001]) {
    await t.test(`timestamp offset ${offset}ms`, () => {
      assert.equal(signed(keys.publicKey, body, headers, center + offset), Math.abs(offset) <= 300000);
    });
  }
  for (const [name, altered] of [
    ['trailing newline', Buffer.concat([body, Buffer.from('\n')])],
    ['leading BOM', Buffer.concat([Buffer.from([239, 187, 191]), body])],
    ['different JSON spacing', Buffer.from(JSON.stringify(JSON.parse(body)))],
    ['Unicode normalization', Buffer.from(body.toString().replace('é', 'e\u0301'))],
    ['same-size bit flip', Buffer.from(body).fill(32, 3, 4)],
  ]) await t.test(`raw-byte change: ${name}`, () => {
    assert.equal(signed(keys.publicKey, altered, headers, center), false);
  });
});

test('public request framing and trailer isolation recover on the next request', async t => {
  let calls = 0;
  const app = await createDiscordApplication({ reserve() { calls++; return 'busy'; } }, config);
  await app.listen(0, '127.0.0.1');
  t.after(async () => { app.getHttpServer().closeAllConnections(); await app.close(); });
  const base = await app.getUrl(), body = '{"type":1}', headers = signature(body);
  const prefix = 'POST /discord/interactions HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n';
  for (const name of ['x-signature-timestamp', 'x-signature-ed25519']) {
    for (const duplicate of [headers[name], 'invalid']) await t.test(`duplicate ${name}=${duplicate === 'invalid' ? 'invalid' : 'identical'}`, async () => {
      const response = await wire(base, prefix + headerLines(headers) + `${name}: ${duplicate}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
      assert.match(response, /^HTTP\/1\.1 401 /); assert.equal(calls, 0);
    });
  }
  await t.test('signature supplied only as chunk trailers never authenticates', async () => {
    const response = await wire(base, prefix + 'Transfer-Encoding: chunked\r\nTrailer: x-signature-timestamp, x-signature-ed25519\r\nConnection: close\r\n\r\n' +
      `${body.length.toString(16)}\r\n${body}\r\n0\r\n${headerLines(headers)}\r\n`);
    assert.match(response, /^HTTP\/1\.1 401 /); assert.equal(calls, 0);
  });
  await t.test('legal chunk extensions preserve signature over decoded body bytes', async () => {
    const response = await wire(base, prefix + headerLines(headers) + 'Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n' +
      `${body.length.toString(16)};fixture=value\r\n${body}\r\n0\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 200 /); assert.match(response, /\{"type":1\}/); assert.equal(calls, 0);
  });
  await t.test('bad signature on one pipelined request cannot poison the next raw body', async () => {
    const first = prefix + headerLines({ ...headers, 'x-signature-ed25519': '0'.repeat(128) }) + `Content-Length: ${body.length}\r\n\r\n${body}`;
    const second = prefix + headerLines(headers) + `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`;
    const response = await wire(base, first + second);
    assert.deepEqual([...response.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map(match => Number(match[1])), [401, 200]);
    assert.equal(calls, 0);
  });
  for (const media of ['application/json; charset=utf-8', 'application/json; charset=UTF-8']) await t.test(`valid media parameters ${media}`, async () => {
    const response = await fetch(base + '/discord/interactions', { method: 'POST', headers: { ...signature(body), 'content-type': media }, body });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { type: 1 });
  });
});

test('private credential and authorization context stay isolated across persistent requests', async t => {
  let calls = 0;
  const app = await createApplication({ ready: true, reconcile: async () => { calls++; },
    monitoring: { render: () => 'atlas_controller_ready 1\n' } }, [secret, 'r'.repeat(64)], [metrics]);
  await app.listen(0, '127.0.0.1');
  t.after(async () => { app.getHttpServer().closeAllConnections(); await app.close(); });
  const base = await app.getUrl();
  for (const token of [secret, 'r'.repeat(64)]) await t.test(`accepted rotation token ${token[0]}`, async () => {
    const before = calls;
    const response = await fetch(base + '/v1/health', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200); assert.equal(calls, before + 1); await response.text();
  });
  for (const token of ['', 'wrong'.repeat(20), metrics, secret + 'x', secret.slice(1), secret.toUpperCase()]) await t.test(`rejected private credential length=${token.length} prefix=${token.slice(0, 1)}`, async () => {
    const before = calls;
    const response = await fetch(base + '/v1/health', { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401); assert.equal(calls, before);
    assert.deepEqual(await response.json(), { code: 'UNAUTHENTICATED', message: 'UNAUTHENTICATED' });
  });
  await t.test('authorization never persists from a preceding keepalive request', async () => {
    const response = await wire(base, `GET /v1/health HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${secret}\r\n\r\n` +
      'GET /v1/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    assert.deepEqual([...response.matchAll(/HTTP\/1\.1 (\d{3}) /g)].map(match => Number(match[1])), [200, 401]);
  });
  await t.test('privileged authorization cannot be supplied through a trailer', async () => {
    const before = calls;
    const response = await wire(base, 'GET /v1/health HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\nTrailer: Authorization\r\nConnection: close\r\n\r\n' +
      `0\r\nAuthorization: Bearer ${secret}\r\n\r\n`);
    assert.match(response, /^HTTP\/1\.1 401 /); assert.equal(calls, before);
  });
  for (const context of [actor, {}, null, [], 'PRIVATE_SENTINEL']) await t.test(`health rejects irrelevant actor context ${JSON.stringify(context)}`, async () => {
    const before = calls;
    const response = await fetch(base + '/v1/health', { headers: { authorization: `Bearer ${secret}`,
      'x-atlas-authorization-context': Buffer.from(JSON.stringify(context)).toString('base64url') } });
    assert.equal(response.status, 400); assert.equal(calls, before);
    assert.doesNotMatch(await response.text(), /PRIVATE_SENTINEL|guildId|userId/);
  });
});
