import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DiscordService } from '../apps/discord-api/service.mjs';
import { ControllerClient } from '../apps/discord-api/controller.mjs';
import { errorText } from '../apps/discord-api/commands.mjs';

test('overlapping pages fill autocomplete with 25 distinct IDs, preserving first matches', async () => {
  const server = i => ({ instanceId: `server-${i}`, displayName: `Server ${i}` });
  const pages = [
    { items: Array.from({ length: 24 }, (_, i) => server(i)), nextCursor: 'next' },
    { items: [server(0), server(23), server(24), server(25)], nextCursor: null }
  ];
  const service = new DiscordService({ controller: { list: async () => pages.shift() } });
  const choices = await service.autocomplete({ instance: '' }, {});
  assert.equal(choices.length, 25);
  assert.equal(new Set(choices.map(c => c.value)).size, 25);
  assert.deepEqual(choices.map(c => c.value), Array.from({ length: 25 }, (_, i) => `server-${i}`));
  assert.equal(choices[0].name, 'Server 0 (server-0)');
});

for (const code of ['constructor', '__proto__', 'toString']) {
  test(`error category ${code} delivers a sanitized final reply and releases its slot`, async () => {
    const deliveries = [];
    const service = new DiscordService({ applicationId: '123456789012345678',
      controller: { status: async () => { throw Object.assign(new Error('private-sentinel'), { code }); } },
      fetchImpl: async (url, init) => { deliveries.push(JSON.parse(init.body)); return new Response('{}'); } });
    const interaction = { id: '223456789012345678', token: 'test' };
    assert.equal(service.reserve(interaction), 'accepted');
    await service.complete(interaction, { action: 'status', instance: 'server' }, {});
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].content, errorText());
    assert.deepEqual(deliveries[0].allowed_mentions, { parse: [] });
    assert.doesNotMatch(deliveries[0].content, /private-sentinel/);
    assert.equal(service.pending.size, 0);
  });
  test(`controller filters upstream ${code} before formatting`, async () => {
    const client = new ControllerClient({ url: 'http://controller:3000', secret: 's'.repeat(64),
      fetchImpl: async () => new Response(JSON.stringify({ code }), { status: 500 }) });
    await assert.rejects(client.list({}), { code: 'DOCKER_UNAVAILABLE' });
  });
}
