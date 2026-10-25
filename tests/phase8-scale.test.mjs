import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { validateRegistry } from '../libs/server-registry/index.mjs';
import { LifecycleObserver } from '../apps/docker-controller/monitoring.mjs';
import { validateBackupConfig } from '../apps/backup-worker/worker.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fleet, actor, harness, settled } from './phase8-harness.mjs';

test('50 instances paginate without duplicates; Discord finds the last page and respects access policy', async t => {
  const instances = fleet(50);
  instances[17].policy.allowedDiscordUsers = ['923456789012345678'];
  const h = await harness(t, instances), found = [];
  let cursor, pages = 0;
  do {
    const result = await h.client.list(actor, cursor, undefined, 7);
    assert.ok(result.items.length <= 7);
    found.push(...result.items.map(e => e.instanceId));
    cursor = result.nextCursor; pages++;
    assert.ok(pages <= 8);
  } while (cursor);
  assert.deepEqual(found, instances.filter(e => e.id !== 'nebula-17').map(e => e.id));
  assert.equal(new Set(found).size, 49);
  assert.deepEqual(await h.discord.autocomplete({ instance: 'nebula-49' }, actor),
    [{ name: 'Synthetic server 49 (nebula-49)', value: 'nebula-49' }]);
  assert.equal((await h.discord.autocomplete({ instance: 'nebula' }, actor)).length, 25);
  assert.deepEqual(await h.discord.autocomplete({ instance: 'nebula-17' }, actor), []);
  await h.discord.complete({ id: '423456789012345678', token: 'mock-only' }, { action: 'list' }, actor);
  const content = h.deliveries.at(-1).content;
  assert.match(content, /nebula-00/); assert.match(content, /Next page:/); assert.ok(!content.includes('nebula-03'));
});

for (const [resource, capacity] of [
  ['memory', { memoryMiB: 192, cpuUnits: 100 }],
  ['CPU', { memoryMiB: 4096, cpuUnits: 3 }]
]) test(`simultaneous fleet starts reserve ${resource} atomically and never evict another game`, async t => {
  const h = await harness(t, fleet(50), capacity);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(release);
  for (const entry of h.instances) h.gates.set(entry.id, gate);
  const results = await Promise.allSettled(h.instances.map((entry, i) =>
    h.client.operate(entry.id, 'start', actor, String(423456789012345678n + BigInt(i)))));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  const rejected = results.filter(r => r.status === 'rejected');
  assert.equal(rejected.length, 47);
  assert.ok(rejected.every(r => r.reason.code === 'RESOURCE_EXHAUSTED'));
  assert.equal(h.service.reservations.size, 3);
  assert.equal(h.service.locks.size, 3);
  await assert.rejects(h.client.operate('nebula-00', 'stop', actor, '523456789012345678'), { code: 'OPERATION_CONFLICT' });
  release(); await settled(h.service);
  assert.equal([...h.states.values()].filter(s => s.State.Status === 'running').length, 3);
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, 0);
  await h.client.operate('nebula-00', 'stop', actor, '623456789012345678'); await settled(h.service);
  await h.client.operate('nebula-49', 'start', actor, '723456789012345678'); await settled(h.service);
  assert.equal(h.service.reservations.size, 3);
  assert.equal(h.states.get('nebula-49').State.Status, 'running');
});

test('overlapping observer polls coalesce; 50-instance sampling and metric series grow linearly', async t => {
  const h = await harness(t, fleet(50));
  for (const data of h.states.values()) data.State.Status = 'running';
  const observer = new LifecycleObserver(h.service, {}); observer.stopped = false;
  h.calls.length = 0;
  const start = performance.now();
  await Promise.all(Array.from({ length: 20 }, () => observer.refresh()));
  t.diagnostic(`50 mock instances, one coalesced poll: ${(performance.now() - start).toFixed(2)}ms`);
  assert.equal(h.calls.filter(c => c[0] === 'inspect').length, 100);
  assert.equal(h.calls.filter(c => c[0] === 'stats').length, 50);
  assert.equal(h.service.monitoring.resources.size, 50);
  const first = h.service.monitoring.render(h.service).trim().split('\n');
  assert.equal(first.filter(s => s.startsWith('atlas_instance_info{')).length, 50);
  assert.equal(first.filter(s => s.startsWith('atlas_instance_state{')).length, 450);
  assert.equal(first.filter(s => s.startsWith('atlas_container_memory_bytes{')).length, 50);
  assert.equal(first.length, 9 + 15 * 50);
  const keys = lines => lines.map(s => s.slice(0, s.lastIndexOf(' '))).sort();
  await observer.refresh();
  assert.deepEqual(keys(h.service.monitoring.render(h.service).trim().split('\n')), keys(first));
  for (const entry of h.instances) assert.ok(first.includes(`atlas_instance_info{instance="${entry.id}",game_type="${entry.gameType}"} 1`));
  assert.ok(!first.join('\n').includes(actor.userId));
});

test('missing containers and sample failures stay local; Engine failure closes admission and recovers', async t => {
  const h = await harness(t, fleet(50));
  for (const data of h.states.values()) data.State.Status = 'running';
  const observer = new LifecycleObserver(h.service, {}); observer.stopped = false;
  await observer.refresh();
  h.failures.set('nebula-00', { statusCode: 404 });
  h.failures.set('stats:nebula-01', true);
  await observer.refresh();
  assert.equal(h.service.ready, true);
  assert.equal(h.service.monitoring.observed.get('nebula-00'), 'missing');
  assert.equal(h.service.monitoring.resources.size, 48);
  assert.equal(h.service.monitoring.resources.has('nebula-01'), false);
  assert.equal((await h.client.status('nebula-49', actor)).docker, 'running');
  const page = await h.client.list(actor);
  assert.equal(page.items[0].docker, 'missing');
  h.failures.set('nebula-02', new Error('Synthetic Engine failure'));
  await observer.refresh(); assert.equal(h.service.ready, false);
  await assert.rejects(h.client.operate('nebula-49', 'stop', actor, '423456789012345678'), { code: 'DOCKER_UNAVAILABLE' });
  assert.equal(h.calls.filter(c => c[0] === 'stop').length, 0);
  h.failures.clear(); await observer.refresh();
  assert.equal(h.service.ready, true); assert.equal(h.service.monitoring.resources.size, 50);
});

for (const [name, mutate] of [
  ['duplicate stable IDs', entries => { entries[49].id = entries[0].id; entries[49].container.requiredLabels['io.atlasdominion.instance'] = entries[0].id; }],
  ['duplicate container ownership', entries => { entries[49].container.name = entries[0].container.name; }],
  ['conflicting native ports', entries => { entries[49].container.publishedPorts[0].hostPort = entries[0].container.publishedPorts[0].hostPort; }],
  ['unknown adapters', entries => { entries[49].adapter.lifecycle = 'executable-plugin'; }],
  ['identity label mismatch', entries => { entries[49].container.requiredLabels['io.atlasdominion.instance'] = 'wrong-instance'; }],
  ['arbitrary execution fields', entries => { entries[49].command = 'arbitrary-command'; }]
]) test(`50-instance registry rejects ${name} at the final entry`, () => {
  const entries = fleet(50); assert.equal(validateRegistry(entries).length, 50);
  mutate(entries); assert.throws(() => validateRegistry(entries));
});

test('backup configuration resolves 50 generic instances and rejects unknown, duplicate or overlapping jobs', () => {
  const instances = fleet(50), root = join(tmpdir(), 'atlas-phase8-config-only');
  const config = { lockDirectory: join(root, 'locks'), jobs: instances.map(entry => ({
    instanceId: entry.id, source: join(root, `source-${entry.id}`), destination: join(root, `archives-${entry.id}`),
    volumeName: `world-${entry.id}`, containerPath: '/world', intervalSeconds: 60, keep: 2,
    minimumFreeBytes: 0, allowRetentionDeletion: false
  })) };
  assert.deepEqual(validateBackupConfig(config, instances).jobs.map(job => job.instanceId), instances.map(entry => entry.id));
  for (const mutate of [
    candidate => { candidate.jobs[49].instanceId = 'unregistered-game'; },
    candidate => { candidate.jobs[49].instanceId = candidate.jobs[0].instanceId; },
    candidate => { candidate.jobs[49].destination = candidate.jobs[0].source; }
  ]) {
    const candidate = structuredClone(config); mutate(candidate);
    assert.throws(() => validateBackupConfig(candidate, instances));
  }
});
