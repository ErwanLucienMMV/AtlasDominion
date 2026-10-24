import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { Fault } from '../apps/docker-controller/security.mjs';
const secret = 's'.repeat(64);
const actor = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: [] };
const policy = { allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] };
test('Nest HTTP boundary authenticates, validates and paginates', async () => {
  const instances = Array.from({ length: 40 }, (_, i) => ({ id: `server-${String(i).padStart(2, '0')}`, policy }));
  const service = { policy, instances, ready: true, reconcile: async () => {},
    status: async id => { if (!instances.some(e => e.id === id)) throw new Fault('UNKNOWN_INSTANCE'); return { instanceId: id }; },
    request: async (id, action, body) => {
      if (Object.keys(body).sort().join() !== 'authorization,idempotencyKey') throw new Fault('INVALID_REQUEST');
      return { status: 202, operation: { instanceId: id, action, state: 'queued' } };
    } };
  const app = await createApplication(service, [secret]);
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const headers = { authorization: `Bearer ${secret}`, 'x-atlas-authorization-context': Buffer.from(JSON.stringify(actor)).toString('base64url') };
    assert.equal((await fetch(`${base}/v1/health`)).status, 401);
    assert.equal((await fetch(`${base}/v1/health`, { headers: { authorization: `Bearer ${secret}` } })).status, 200);
    const response = await fetch(`${base}/v1/servers?limit=10`, { headers }); assert.equal(response.status, 200);
    const first = await response.json(); assert.equal(first.items.length, 10); assert.ok(first.nextCursor);
    const second = await (await fetch(`${base}/v1/servers?limit=10&cursor=${first.nextCursor}`, { headers })).json();
    assert.equal(second.items[0].instanceId, 'server-10');
    assert.equal((await fetch(`${base}/v1/servers?limit=101`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/v1/servers?container=arbitrary`, { headers })).status, 400);
    assert.equal((await fetch(`${base}/v1/servers/unknown`, { headers })).status, 404);
    assert.equal((await fetch(`${base}/v1/servers`, { headers: { authorization: `Bearer ${secret}` } })).status, 400);
    for (const body of ['{', JSON.stringify({ command: 'private-sentinel' }), JSON.stringify({ padding: 'x'.repeat(17000) })]) {
      const result = await fetch(`${base}/v1/servers/server-00/start`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body });
      assert.equal(result.status, 400); assert.ok(!(await result.text()).includes('private-sentinel'));
    }
    assert.equal((await fetch(`${base}/v1/servers/server-00/start`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ authorization: actor, idempotencyKey: '0123456789abcdef' }) })).status, 202);
    assert.equal((await fetch(`${base}/v1/servers`, { headers: { ...headers, 'x-atlas-authorization-context': Buffer.from(JSON.stringify({ ...actor, command: 'exec' })).toString('base64url') } })).status, 400);
  } finally { await app.close(); }
});
