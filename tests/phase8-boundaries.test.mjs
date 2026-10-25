import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateBackupConfig } from '../apps/backup-worker/worker.mjs';
import { LifecycleObserver } from '../apps/docker-controller/monitoring.mjs';
import { actor, fleet, harness, settled } from './phase8-harness.mjs';

function backupConfig(entries) {
  const root = join(tmpdir(), 'atlas-phase8-validation-only');
  return { lockDirectory: join(root, 'locks'), jobs: entries.map(e => ({ instanceId: e.id,
    source: join(root, `source-${e.id}`), destination: join(root, `archive-${e.id}`),
    volumeName: `world-${e.id}`, containerPath: '/world', intervalSeconds: 60,
    keep: 2, minimumFreeBytes: 0, allowRetentionDeletion: false })) };
}
for (const [name, mutate] of Object.entries({
  'source inside another game archive': (j, c) => { j.source = join(c.jobs[0].destination, 'nested'); },
  'archive inside another game source': (j, c) => { j.destination = join(c.jobs[0].source, 'nested'); },
  'source ancestor of another source': (j, c) => { j.source = join(c.jobs[0].source, '..'); },
  'normalized path overlap': (j, c) => { j.destination = join(c.jobs[0].source, 'nested', '..'); },
  'lock directory overlap': (j, c) => { j.destination = join(c.lockDirectory, 'nested'); },
  'relative source': j => { j.source = 'relative-source'; },
  'relative archive': j => { j.destination = '../archive'; },
  'socket volume path': j => { j.volumeName = '/var/run/docker.sock'; },
  'container parent traversal': j => { j.containerPath = '/world/../etc'; },
  'container dot traversal': j => { j.containerPath = '/world/./data'; },
  'relative container path': j => { j.containerPath = 'world'; },
  'zero retention count': j => { j.keep = 0; },
  'fractional retention count': j => { j.keep = 1.5; },
  'too frequent schedule': j => { j.intervalSeconds = 59; },
  'infinite schedule': j => { j.intervalSeconds = Infinity; },
  'negative free space': j => { j.minimumFreeBytes = -1; },
  'implicit retention approval': j => { delete j.allowRetentionDeletion; },
  'string retention approval': j => { j.allowRetentionDeletion = 'true'; }
})) test(`50-game backup configuration rejects ${name}`, () => {
  const entries = fleet(50), config = backupConfig(entries);
  assert.equal(validateBackupConfig(config, entries).jobs.length, 50);
  mutate(config.jobs[49], config);
  assert.throws(() => validateBackupConfig(config, entries));
});

for (const sample of [null, {}, { memory_stats: { usage: -1 } },
  { memory_stats: { usage: Infinity }, cpu_stats: { cpu_usage: { total_usage: 1 } } },
  { memory_stats: { usage: 1 }, cpu_stats: { cpu_usage: { total_usage: NaN } } },
  { memory_stats: { usage: '4096' }, cpu_stats: { cpu_usage: { total_usage: 1 } } }])
  test(`invalid Engine sample ${JSON.stringify(sample)} removes stale data without poisoning the fleet`, async t => {
    const h = await harness(t, fleet(3));
    for (const data of h.states.values()) data.State.Status = 'running';
    const observer = new LifecycleObserver(h.service, {}); observer.stopped = false;
    await observer.refresh(); assert.equal(h.service.monitoring.resources.size, 3);
    const inspect = h.docker.inspect.bind(h.docker);
    h.docker.inspect = async (...args) => {
      const result = await inspect(...args);
      if (args[0].id === 'nebula-01') result.container.stats = async () => sample;
      return result;
    };
    await observer.refresh();
    assert.equal(h.service.ready, true);
    assert.deepEqual([...h.service.monitoring.resources.keys()], ['nebula-00', 'nebula-02']);
    assert.doesNotMatch(h.service.monitoring.render(h.service), /(?:NaN|Infinity|undefined)/);
    h.docker.inspect = inspect; await observer.refresh();
    assert.equal(h.service.monitoring.resources.size, 3);
  });

test('failed audit admission blocks the fleet until durable recovery and never starts a game', async t => {
  const h = await harness(t, fleet(3)), append = h.service.audit.append;
  h.service.audit.append = async () => { throw new Error('synthetic-secret-must-not-leak'); };
  await assert.rejects(h.client.operate('nebula-00', 'start', actor, '423456789012345678'), { code: 'DOCKER_UNAVAILABLE' });
  await assert.rejects(h.client.operate('nebula-02', 'start', actor, '423456789012345679'), { code: 'DOCKER_UNAVAILABLE' });
  assert.equal(h.service.failedAudits.size, 1); assert.equal(h.service.locks.size, 0);
  assert.equal(h.calls.filter(c => c[0] === 'start').length, 0);
  await h.service.reconcile(); assert.equal(h.service.ready, false);
  h.service.audit.append = append; await h.service.reconcile();
  assert.equal(h.service.ready, true); assert.equal(h.service.failedAudits.size, 0);
  assert.equal(h.service.reservations.size, 0);
  await h.client.operate('nebula-02', 'start', actor, '423456789012345680'); await settled(h.service);
  assert.deepEqual(h.calls.filter(c => c[0] === 'start'), [['start', 'nebula-02']]);
  assert.ok(h.audit.every(e => !JSON.stringify(e).includes('synthetic-secret')));
});

test('container replacement after accepted audit cannot redirect an approved start', async t => {
  const h = await harness(t, fleet(3)), append = h.service.audit.append;
  h.service.audit.append = async event => {
    await append(event);
    if (event.outcome === 'accepted') h.states.get('nebula-02').Id = 'replacement-not-approved';
  };
  const op = await h.client.operate('nebula-02', 'start', actor, '423456789012345678');
  await settled(h.service);
  const result = await h.client.operation(op.operationId, actor);
  assert.equal(result.state, 'failed'); assert.equal(result.result, null);
  assert.equal(h.calls.filter(c => c[0] === 'start').length, 0);
});

test('hung Engine stats stalls subsequent fleet samples while health remains ready (availability limitation)', async t => {
  const h = await harness(t, fleet(3));
  for (const data of h.states.values()) data.State.Status = 'running';
  const observer = new LifecycleObserver(h.service, {}); observer.stopped = false;
  const inspect = h.docker.inspect.bind(h.docker);
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  h.docker.inspect = async (...args) => {
    const result = await inspect(...args);
    if (args[0].id === 'nebula-00') {
      const stats = result.container.stats;
      result.container.stats = async () => { entered(); await gate; return stats(); };
    }
    return result;
  };
  const refresh = observer.refresh();
  try {
    await started;
    assert.equal(observer.pending, true);
    assert.equal(h.service.ready, true);
    await Promise.all(Array.from({ length: 20 }, () => observer.refresh()));
    assert.equal(h.service.monitoring.resources.size, 0);
    assert.equal(h.calls.filter(c => c[0] === 'stats').length, 0);
    const health = await fetch(`${await h.app.getUrl()}/v1/health`, {
      headers: { authorization: `Bearer ${h.secret}` }
    });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ready: true });
    t.diagnostic('A hung stats promise blocks all later samples; overlapping refresh calls return without completing that poll, and health still reports ready.');
  } finally { release(); await refresh; }
  assert.equal(observer.pending, false);
  assert.equal(h.service.monitoring.resources.size, 3);
});
