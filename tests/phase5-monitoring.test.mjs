import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { Monitoring, LifecycleObserver } from '../apps/docker-controller/monitoring.mjs';
import { AuditLog } from '../apps/docker-controller/audit.mjs';
import { createApplication } from '../apps/docker-controller/http.mjs';

function setup(count = 3) {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/instance.json', import.meta.url)));
  const instances = Array.from({ length: count }, (_, i) => {
    const e = structuredClone(fixture); e.id = `sample-${i}`; e.container.name = `game-${i}`;
    e.container.requiredLabels['io.atlasdominion.instance'] = e.id; e.container.publishedPorts[0].hostPort += i; return e;
  });
  const states = instances.map(() => 'running');
  const service = new ControllerService({ instances, policy: {}, capacity: { memoryMiB: 30000, cpuUnits: 8 },
    timeoutMs: 2000, stopTimeoutSeconds: 1, audit: { append: async () => {} },
    docker: { inspect: async e => ({ data: { State: { Status: states[instances.findIndex(entry => entry.id === e.id)] } },
      container: { stats: async () => ({ memory_stats: { usage: 1024 }, cpu_stats: { cpu_usage: { total_usage: 2e9 } } }) } }) } });
  return { service, states };
}
test('generic metrics discover 40 instances and separate reservations from host consumption', async () => {
  const { service } = setup(40); await service.reconcile();
  const metrics = service.monitoring.render(service);
  assert.equal((metrics.match(/atlas_instance_info\{/g) ?? []).length, 40);
  assert.match(metrics, /atlas_controller_ready 1/);
  assert.match(metrics, /atlas_reserved\{resource="memoryMiB"\}/);
  assert.ok(!metrics.includes('userId'));
});
test('unexpected transitions count once; intentional stops are suppressed; startup does not imply crashes', async () => {
  const { service, states } = setup(); await service.reconcile();
  service.desired.set('sample-0', 'wanted_stopped');
  states[0] = states[1] = 'exited'; await service.reconcile(); await service.reconcile();
  assert.equal(service.monitoring.exits.get('sample-0'), undefined);
  assert.equal(service.monitoring.exits.get('sample-1'), 1);
  const fresh = setup(); fresh.states[0] = 'exited'; await fresh.service.reconcile();
  assert.equal(fresh.service.monitoring.exits.size, 0);
});
test('audit replay restores only approved desired state without rewriting history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-phase5-'));
  const audit = new AuditLog(directory);
  for (const [instanceId, operation] of [['sample-0', 'start'], ['sample-0', 'stop'], ['unknown', 'start']])
    await audit.append({ timestamp: '2026-10-25T12:00:00.000Z', instanceId, operation, outcome: 'accepted', error: null });
  const before = await readFile(join(directory, '2026-10-25.jsonl'), 'utf8');
  assert.deepEqual([...await audit.desiredStates(setup().service.instances)], [['sample-0', 'wanted_stopped']]);
  assert.equal(await readFile(join(directory, '2026-10-25.jsonl'), 'utf8'), before);
});
test('authenticated metrics expose no Docker details and reject public requests', async () => {
  const { service } = setup(); await service.reconcile();
  const secret = 's'.repeat(32), app = await createApplication(service, [secret]);
  await app.listen(0, '127.0.0.1');
  try {
    const url = `${await app.getUrl()}/metrics`;
    assert.equal((await fetch(url)).status, 401);
    const response = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /text\/plain/);
    const body = await response.text(); assert.match(body, /atlas_instance_info/); assert.ok(!body.includes(secret));
  } finally { await app.close(); }
});
test('event stream chunking, disconnect recovery, periodic repair and resource samples', async () => {
  const { service, states } = setup(); const streams = []; let connections = 0;
  const observer = new LifecycleObserver(service, { getEvents: async () => { connections++; const s = new PassThrough(); streams.push(s); return s; } }, { intervalMs: 20, retryMs: 10 }).start();
  const wait = async predicate => { const end = Date.now() + 2000; while (!predicate()) { assert.ok(Date.now() < end); await new Promise(r => setTimeout(r, 5)); } };
  try {
    await wait(() => service.monitoring.resources.size === 3);
    states[1] = 'exited'; streams[0].write('{"Type":"con'); streams[0].write('tainer"}\n');
    await wait(() => service.monitoring.observed.get('sample-1') === 'exited');
    streams[0].end(); await wait(() => connections > 1);
    states[2] = 'exited'; await wait(() => service.monitoring.observed.get('sample-2') === 'exited');
    assert.match(service.monitoring.render(service), /atlas_container_memory_bytes\{instance="sample-0",game_type="minecraft"\} 1024/);
  } finally { observer.stop(); }
  assert.equal(service.monitoring.streamUp, false);
});
test('fixed operation outcome series count terminal results', () => {
  const m = new Monitoring(); m.outcome({ instanceId: 'sample-0', action: 'start', state: 'completed' });
  assert.equal(m.outcomes.get('sample-0:start:completed'), 1);
});
