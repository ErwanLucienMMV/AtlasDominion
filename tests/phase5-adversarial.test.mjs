// Acceptance boundaries from docs/PHASE_5_MONITORING.md and SECURITY.md.
// All Docker behavior is simulated; no Engine or production data is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { LifecycleObserver } from '../apps/docker-controller/monitoring.mjs';
import { AuditLog } from '../apps/docker-controller/audit.mjs';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { DockerAccess } from '../apps/docker-controller/docker.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function until(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'condition did not settle'); await new Promise(r => setTimeout(r, 5)); }
}
function fixture(count = 2) {
  const base = JSON.parse(readFileSync(new URL('./fixtures/instance.json', import.meta.url)));
  const instances = Array.from({ length: count }, (_, i) => {
    const entry = structuredClone(base); entry.id = `adversarial-${i}`; entry.container.name = `approved-${i}`;
    entry.container.requiredLabels['io.atlasdominion.instance'] = entry.id;
    entry.container.publishedPorts[0].hostPort += i; return entry;
  });
  const states = instances.map(() => 'running');
  const calls = []; const hooks = { inspect: null, stats: null };
  const service = new ControllerService({ instances, policy: {}, capacity: { memoryMiB: 30000, cpuUnits: 8 },
    timeoutMs: 1100, stopTimeoutSeconds: 1, audit: { append: async () => {} },
    docker: { async inspect(entry) {
      calls.push(['inspect', entry.id]); if (hooks.inspect) await hooks.inspect(entry);
      return { data: { State: { Status: states[instances.findIndex(e => e.id === entry.id)] } },
        container: { async stats(options) { calls.push(['stats', entry.id, options]); return hooks.stats ? hooks.stats(entry) : { memory_stats: { usage: 2048 }, cpu_stats: { cpu_usage: { total_usage: 3e9 } } }; } } };
    } } });
  return { service, states, calls, hooks };
}
function manualObserver(service) {
  const observer = new LifecycleObserver(service, {}); observer.stopped = false; return observer;
}

test('event storms never overlap observer reconciliation or trust event identities', async () => {
  const { service, calls } = fixture(); const gate = deferred(); const stream = new PassThrough();
  let active = 0, peak = 0, passes = 0;
  const reconcile = service.reconcile.bind(service);
  service.reconcile = async () => { active++; peak = Math.max(peak, active); passes++; try { await gate.promise; await reconcile(); } finally { active--; } };
  const observer = new LifecycleObserver(service, { getEvents: async () => stream }, { intervalMs: 10000 }).start();
  try {
    await until(() => active === 1);
    for (let i = 0; i < 500; i++) stream.write('{"Type":"container","Actor":{"ID":"host-root","Attributes":{"name":"unapproved"}}}\n');
    gate.resolve(); await until(() => !observer.pending);
    assert.equal(peak, 1); assert.equal(passes, 1);
    assert.ok(calls.every(call => service.instances.some(e => e.id === call[1])));
    assert.ok(calls.filter(c => c[0] === 'stats').every(c => c[2].stream === false));
  } finally { gate.resolve(); observer.stop(); }
});

test('many valid short event frames in one chunk do not violate the per-frame 64 KiB limit', async () => {
  const { service } = fixture(); const stream = new PassThrough();
  const observer = new LifecycleObserver(service, { getEvents: async () => stream }, { intervalMs: 10000, retryMs: 10000 }).start();
  try {
    await until(() => service.monitoring.streamUp);
    stream.write('{"Type":"container"}\n'.repeat(4000)); await tick();
    assert.equal(stream.destroyed, false, 'valid coalesced frames must not cause reconnect churn');
  } finally { observer.stop(); }
});

test('late event connection after shutdown is destroyed without reconciliation', async () => {
  const { service, calls } = fixture(); const gate = deferred(); const stream = new PassThrough();
  const observer = new LifecycleObserver(service, { getEvents: () => gate.promise }).start();
  observer.stop(); gate.resolve(stream); await tick();
  assert.equal(stream.destroyed, true); assert.equal(service.monitoring.streamUp, false); assert.deepEqual(calls, []);
});

test('shutdown during a blocked reconciliation prevents subsequent Docker stats calls', async () => {
  const { service, hooks, calls } = fixture(); const gate = deferred(); hooks.inspect = () => gate.promise;
  const observer = manualObserver(service); const refresh = observer.refresh();
  await tick(); observer.stop(); gate.resolve(); await refresh;
  assert.deepEqual(calls.filter(c => c[0] === 'stats'), [], 'shutdown must not initiate additional sampling');
});

test('one failed stats sample does not prevent sampling other approved instances', async () => {
  const { service, hooks } = fixture(); hooks.stats = entry => {
    if (entry.id.endsWith('-0')) throw new Error('private Docker diagnostic');
    return { memory_stats: { usage: 23 }, cpu_stats: { cpu_usage: { total_usage: 2e9 } } };
  };
  await manualObserver(service).refresh();
  assert.equal(service.monitoring.resources.has('adversarial-0'), false);
  assert.deepEqual(service.monitoring.resources.get('adversarial-1'), { memory: 23, cpu: 2 });
  assert.ok(!service.monitoring.render(service).includes('private Docker diagnostic'));
});

for (const [name, memory, cpu] of [
  ['missing', undefined, undefined], ['null', null, null], ['strings', '42', '7'],
  ['NaN', NaN, NaN], ['infinite', Infinity, Infinity], ['negative memory', -1, 1], ['negative CPU', 1, -1],
]) test(`invalid resource sample is omitted: ${name}`, async () => {
  const { service, hooks } = fixture(1);
  hooks.stats = () => ({ memory_stats: { usage: memory }, cpu_stats: { cpu_usage: { total_usage: cpu } } });
  await manualObserver(service).refresh(); assert.equal(service.monitoring.resources.size, 0);
});

for (const state of ['created', 'exited', 'dead', 'paused', 'restarting', 'removing'])
  test(`resources from a formerly running instance are omitted after ${state}`, async () => {
    const { service, states, calls } = fixture(1); const observer = manualObserver(service);
    await observer.refresh(); assert.equal(service.monitoring.resources.size, 1);
    calls.length = 0; states[0] = state; await observer.refresh();
    assert.equal(service.monitoring.resources.size, 0); assert.equal(calls.filter(c => c[0] === 'stats').length, 0);
  });

test('Engine outage preserves last good samples but marks controller unready and does not advance freshness', async () => {
  const { service, hooks } = fixture(); const observer = manualObserver(service); await observer.refresh();
  const before = service.monitoring.lastReconcile; const resources = [...service.monitoring.resources];
  hooks.inspect = () => { throw new Error('daemon unavailable'); }; await observer.refresh();
  assert.equal(service.ready, false); assert.equal(service.monitoring.lastReconcile, before);
  assert.deepEqual([...service.monitoring.resources], resources);
});

for (const state of ['exited', 'dead', 'missing']) for (const desired of [undefined, 'wanted_running', 'wanted_stopped'])
  test(`exit counting for ${state} with intent ${desired ?? 'unknown'}`, () => {
    const { service } = fixture(1); const monitoring = service.monitoring;
    monitoring.observe('adversarial-0', 'running', desired); monitoring.observe('adversarial-0', state, desired);
    monitoring.observe('adversarial-0', state, desired);
    assert.equal(monitoring.exits.get('adversarial-0') ?? 0, desired === 'wanted_stopped' ? 0 : 1);
    monitoring.observe('adversarial-0', 'running', desired); monitoring.observe('adversarial-0', state, desired);
    assert.equal(monitoring.exits.get('adversarial-0') ?? 0, desired === 'wanted_stopped' ? 0 : 2);
  });

test('audit replay follows filename and append order and ignores nonaccepted and unknown operations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-p5-order-'));
  const event = (operation, outcome = 'accepted', instanceId = 'adversarial-0') => JSON.stringify({ timestamp: '2026-10-25T00:00:00Z', instanceId, operation, outcome, error: null });
  await writeFile(join(directory, '2026-10-24.jsonl'), `${event('start')}\n`);
  await writeFile(join(directory, '2026-10-25.jsonl'), [event('stop'), event('start', 'failed'), event('start', 'completed'), event('start', 'accepted', 'foreign'), event('exec')].join('\n') + '\n');
  await writeFile(join(directory, 'ignored.jsonl'), 'damaged unrelated file');
  const before = await readFile(join(directory, '2026-10-25.jsonl'), 'utf8');
  assert.deepEqual([...await new AuditLog(directory).desiredStates(fixture().service.instances)], [['adversarial-0', 'wanted_stopped']]);
  assert.equal(await readFile(join(directory, '2026-10-25.jsonl'), 'utf8'), before);
});

for (const [name, mutate] of [
  ['spoofed label', data => { data.Config.Labels['io.atlasdominion.instance'] = 'foreign'; }],
  ['renamed container', data => { data.Name = '/foreign'; }],
  ['privileged container', data => { data.HostConfig.Privileged = true; }],
  ['host network', data => { data.HostConfig.NetworkMode = 'host'; }],
  ['management network attachment', data => { data.NetworkSettings = { Networks: { 'atlas-monitoring': {} } }; }],
  ['Docker socket mount', data => { data.Mounts = [{ Type: 'bind', Source: '/var/run/docker.sock', Destination: '/socket' }]; }],
  ['root user', data => { data.Config.User = '0:0'; }],
  ['unapproved published port', data => { data.HostConfig.PortBindings['9999/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '9999' }]; }],
]) test(`sampling rechecks identity after reconciliation: ${name}`, async () => {
  const { service } = fixture(1); const entry = service.instances[0]; let inspections = 0, samples = 0;
  const port = entry.container.publishedPorts[0];
  service.docker = new DockerAccess({ getContainer() { return {
    async inspect() {
      const data = { Id: 'pinned-approved-id', Name: `/${entry.container.name}`, Config: { Labels: structuredClone(entry.container.requiredLabels), User: '1000:1000' },
        State: { Status: 'running' }, NetworkSettings: { Networks: { [`atlas-game-${entry.id}`]: {} } },
        HostConfig: { NanoCpus: 2e9, PidsLimit: 1024, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' }, NetworkMode: `atlas-game-${entry.id}`,
          Memory: entry.resources.hardMemoryMiB === null ? 0 : entry.resources.hardMemoryMiB * 1048576,
          PortBindings: { [`${port.containerPort}/${port.protocol}`]: [{ HostIp: '127.0.0.1', HostPort: String(port.hostPort) }] } } };
      if (++inspections > 1) mutate(data); return data;
    }, async stats() { samples++; return {}; },
  }; } }, ['127.0.0.1']);
  await manualObserver(service).refresh();
  assert.equal(inspections, 2); assert.equal(samples, 0); assert.equal(service.monitoring.resources.size, 0);
});

test('periodic reconciliation repairs state even when every event connection fails', async () => {
  const { service, states } = fixture(1); let connections = 0;
  const observer = new LifecycleObserver(service, { async getEvents() { connections++; throw new Error('no stream'); } }, { intervalMs: 10, retryMs: 10 }).start();
  try {
    await until(() => service.monitoring.observed.get('adversarial-0') === 'running');
    states[0] = 'exited'; await until(() => service.monitoring.observed.get('adversarial-0') === 'exited');
    assert.equal(service.monitoring.streamUp, false); assert.ok(connections > 0); assert.equal(service.ready, true);
  } finally { observer.stop(); }
});

for (const payload of ['null\n', '{\n', 'x'.repeat(65537), '{"Type":"container"' + ' '.repeat(65537)])
  test(`invalid event frame disconnects safely (${payload.length} bytes, ${payload.slice(0, 10).trim()})`, async () => {
    const { service } = fixture(1); const stream = new PassThrough();
    const observer = new LifecycleObserver(service, { getEvents: async () => stream }, { intervalMs: 10000, retryMs: 10000 }).start();
    try {
      await until(() => service.monitoring.streamUp); stream.write(payload); await tick();
      assert.equal(stream.destroyed, true); assert.equal(service.monitoring.streamUp, false);
      assert.equal(service.instances.length, 1);
    } finally { observer.stop(); }
  });

test('audit persistence failure is visible in metrics until the exact record is durably retried', async () => {
  const { service } = fixture(1); const event = { timestamp: '2026-10-25T00:00:00Z', instanceId: 'adversarial-0', operation: 'start', outcome: 'completed', error: null };
  service.failedAudits.set('pending-operation', event); service.audit.append = async () => { throw new Error('disk full'); };
  await service.reconcile(); assert.equal(service.ready, false);
  assert.match(service.monitoring.render(service), /atlas_controller_audit_pending 1\n/);
  assert.match(service.monitoring.render(service), /atlas_controller_ready 0\n/);
  service.audit.append = async actual => assert.deepEqual(actual, event);
  await service.reconcile(); assert.equal(service.ready, true); assert.equal(service.failedAudits.size, 0);
});

for (const record of ['{', 'null', '[]', '42', '{}', '{"instanceId":"adversarial-0","operation":"stop","outcome":"accepted","timestamp":false}'])
  test(`damaged audit history fails closed: ${record}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-p5-corrupt-'));
    await writeFile(join(directory, '2026-10-25.jsonl'), `${record}\n`);
    await assert.rejects(new AuditLog(directory).desiredStates(fixture().service.instances));
  });

test('concurrent audit appends preserve all records and strip sensitive extras', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-p5-append-')); const audit = new AuditLog(directory);
  await Promise.all(Array.from({ length: 100 }, (_, i) => audit.append({ timestamp: '2026-10-25T00:00:00Z', instanceId: `sample-${i}`, operation: 'start', outcome: 'accepted', error: null, authorization: 'SECRET', userId: 'PERSONAL' })));
  const text = await readFile(join(directory, '2026-10-25.jsonl'), 'utf8'); const records = text.trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 100); assert.equal(new Set(records.map(r => r.instanceId)).size, 100);
  assert.ok(!text.includes('SECRET')); assert.ok(!text.includes('PERSONAL'));
  assert.deepEqual(await readdir(directory), ['2026-10-25.jsonl']);
});

test('metrics credential isolation survives path, method, query and authentication variations', async t => {
  const { service, calls } = fixture(); const control = 'c'.repeat(32), metrics = 'm'.repeat(32);
  const app = await createApplication(service, [control], [metrics]); await app.listen(0, '127.0.0.1');
  try {
    const base = await app.getUrl();
    for (const path of ['/v1/health', '/v1/servers', '/v1/servers/adversarial-0/start', '/v1/operations/00000000-0000-0000-0000-000000000000', '/metrics/', '/Metrics', '/%6detrics'])
      await t.test(`metrics token cannot cross boundary at ${path}`, async () => {
        const response = await fetch(base + path, { headers: { authorization: `Bearer ${metrics}` } });
        assert.equal(response.status, 401); assert.ok(!(await response.text()).includes(metrics));
      });
    for (const authorization of ['', `Basic ${metrics}`, `Bearer ${metrics}x`, `Bearer ${control}`, `Bearer ${metrics}, Bearer ${control}`])
      await t.test(`reject metrics auth variation ${authorization.slice(0, 8)}`, async () => {
        assert.equal((await fetch(base + '/metrics', { headers: { authorization } })).status, 401);
      });
    assert.equal((await fetch(base + '/metrics?secret=DO-NOT-ECHO', { headers: { authorization: `Bearer ${metrics}` } })).status, 200);
    const response = await fetch(base + '/metrics', { method: 'POST', headers: { authorization: `Bearer ${metrics}` } });
    assert.equal(response.status, 400); assert.deepEqual(calls, []);
  } finally { await app.close(); }
});
