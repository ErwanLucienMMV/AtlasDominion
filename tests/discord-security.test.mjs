import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { publicKey, signed, actor, allowed, RateLimit, validateConfig } from '../apps/discord-api/security.mjs';
import { ControllerClient } from '../apps/discord-api/controller.mjs';

const identity = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: ['323456789012345678'] };
const policy = { allowedDiscordGuilds: [identity.guildId], allowedDiscordUsers: [], allowedDiscordRoles: identity.roleIds };
test('Ed25519 verification binds exact bytes and timestamp and rejects stale or malformed requests', () => {
  const keys = generateKeyPairSync('ed25519');
  const hex = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  const key = publicKey(hex), body = Buffer.from('{ "type": 1 }'), now = Date.now();
  const timestamp = String(Math.floor(now / 1000));
  const headers = { 'x-signature-timestamp': timestamp, 'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), body]), keys.privateKey).toString('hex') };
  assert.ok(signed(key, body, headers, now));
  assert.equal(signed(key, Buffer.from('{"type":1}'), headers, now), false);
  assert.equal(signed(key, body, headers, now + 301000), false);
  assert.equal(signed(key, body, { ...headers, 'x-signature-timestamp': '0' }, now), false);
  assert.equal(signed(key, body, {}), false);
  assert.throws(() => publicKey('bad'));
  assert.equal(validateConfig({ publicKey: hex, applicationId: identity.guildId, policy }).policy, policy);
  assert.throws(() => validateConfig({ publicKey: hex, applicationId: identity.guildId, policy: { ...policy, allowedDiscordGuilds: [] } }));
});
test('guild AND user-or-role policy rejects DMs and malformed roles', () => {
  assert.deepEqual(actor({ guild_id: identity.guildId, member: { user: { id: identity.userId }, roles: identity.roleIds } }), identity);
  assert.ok(allowed(policy, identity));
  assert.equal(allowed(policy, { ...identity, guildId: '423456789012345678' }), false);
  assert.equal(allowed(policy, { ...identity, roleIds: [] }), false);
  assert.throws(() => actor({ user: { id: identity.userId } }));
  assert.throws(() => actor({ guild_id: identity.guildId, member: { user: { id: identity.userId }, roles: Array(101).fill(identity.roleIds[0]) } }));
});
test('rate limiter bounds memory, rejects saturation and recovers after expiry', () => {
  let now = 0; const limiter = new RateLimit({ now: () => now, limit: 1, maximum: 1 });
  assert.ok(limiter.take(identity)); assert.equal(limiter.take(identity), false);
  assert.equal(limiter.take({ ...identity, userId: '423456789012345678' }), false);
  now = 60000; assert.ok(limiter.take(identity));
});
test('controller client sends ephemeral context and stable idempotency without forwarding upstream errors', async () => {
  const calls = [];
  const client = new ControllerClient({ url: 'http://controller:3000', secret: 's'.repeat(64), fetchImpl: async (url, options) => {
    calls.push({ url, ...options }); return new Response(JSON.stringify({ items: [], nextCursor: null }));
  } });
  await client.list(identity); await client.operate('example', 'start', identity, 'interaction'); await client.operate('example', 'start', identity, 'interaction');
  assert.deepEqual(JSON.parse(Buffer.from(calls[0].headers['x-atlas-authorization-context'], 'base64url')), identity);
  assert.equal(calls[1].body, calls[2].body); assert.equal(calls[0].redirect, 'error');
  client.fetch = async () => new Response(JSON.stringify({ code: 'UNKNOWN_INSTANCE', message: 'secret' }), { status: 404 });
  await assert.rejects(client.status('missing', identity), error => error.code === 'UNKNOWN_INSTANCE' && !error.message.includes('secret'));
  client.fetch = async () => { throw new Error('secret'); };
  await assert.rejects(client.list(identity), { message: 'DOCKER_UNAVAILABLE' });
});
