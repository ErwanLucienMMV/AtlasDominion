import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { DockerAccess } from '../apps/docker-controller/docker.mjs';
const actor = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: [] };
const policy = { allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] };
function setup({ count = 2, capacity = 20000, delay = 0, timeout = 10000 } = {}) {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/instance.json', import.meta.url)));
  const instances = Array.from({ length: count }, (_, i) => {
    const e = structuredClone(fixture); e.id = `server-${i}`; e.container.name = `container-${i}`;
    e.container.requiredLabels['io.atlasdominion.instance'] = e.id; e.container.publishedPorts[0].hostPort += i; Object.assign(e.policy, policy); return e;
  });
  const data = instances.map(e => ({ Id: `docker-${e.id}`, Name: `/${e.container.name}`, Config: { Labels: e.container.requiredLabels }, State: { Status: 'exited' }, HostConfig: { RestartPolicy: { Name: 'no' }, PortBindings: { '25565/tcp': [{ HostPort: String(e.container.publishedPorts[0].hostPort), HostIp: '0.0.0.0' }] } } }));
  let starts = 0; const events = [];
  const docker = new DockerAccess({ getContainer: name => {
    const d = data.find(d => d.Id === name || d.Name === `/${name}`);
    return { inspect: async () => { if (!d) throw { statusCode: 404 }; return structuredClone(d); },
      start: async () => { starts++; await new Promise(r => setTimeout(r, delay)); d.State.Status = 'running'; },
      stop: async () => { d.State.Status = 'exited'; } };
  } }, ['0.0.0.0']);
  const service = new ControllerService({ instances, docker, policy, capacity: { memoryMiB: capacity, cpuUnits: 8 }, audit: { append: async e => events.push(e) }, timeoutMs: timeout, stopTimeoutSeconds: 1 });
  return { service, data, events, starts: () => starts };
}
const request = key => ({ authorization: actor, idempotencyKey: key.padEnd(16, 'x') });
async function settled(service, id) {
  const until = Date.now() + 3000;
  while (service.locks.has(id) && Date.now() < until) await new Promise(r => setTimeout(r, 5));
  assert.equal(service.locks.has(id), false);
}
test('multiple instances of same game, unknown and denied authorization', async () => {
  const { service } = setup(); await service.reconcile();
  assert.equal((await service.status('server-1', actor)).gameType, 'minecraft');
  await assert.rejects(service.status('unknown', actor), /UNKNOWN_INSTANCE/);
  await assert.rejects(service.status('server-0', { ...actor, userId: '999999999999999999' }), /FORBIDDEN/);
});
test('start/stop are idempotent, replay operation and sanitize audit', async () => {
  const { service, starts, events } = setup(); await service.reconcile();
  const result = await service.request('server-0', 'start', request('first')); assert.equal(result.status, 202);
  await settled(service, 'server-0');
  assert.equal(service.operation(result.operation.operationId, actor).state, 'completed');
  assert.equal((await service.request('server-0', 'start', request('first'))).operation.operationId, result.operation.operationId);
  assert.equal((await service.request('server-0', 'start', request('second'))).operation.result, 'already_running');
  assert.equal(starts(), 1);
  await assert.rejects(service.request('server-0', 'stop', request('first')), /OPERATION_CONFLICT/);
  await service.request('server-0', 'stop', request('third')); await settled(service, 'server-0');
  assert.equal((await service.request('server-0', 'stop', request('fourth'))).operation.result, 'already_stopped');
  assert.ok(!JSON.stringify(events).includes(actor.userId));
  assert.deepEqual(Object.keys(events[0]).sort(), ['error', 'instanceId', 'operation', 'outcome', 'timestamp']);
});
test('per-instance exclusion and atomic cross-instance capacity admission', async () => {
  const { service, starts } = setup({ capacity: 6144, delay: 100 }); await service.reconcile();
  const outcomes = await Promise.allSettled([service.request('server-0', 'start', request('one')), service.request('server-0', 'stop', request('two')), service.request('server-1', 'start', request('three'))]);
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].reason.code, 'OPERATION_CONFLICT');
  assert.equal(outcomes[2].reason.code, 'RESOURCE_EXHAUSTED');
  await settled(service, 'server-0'); assert.equal(starts(), 1);
});
test('startup reserves already running instances and missing remains visible', async () => {
  const { service, data } = setup({ capacity: 6144 }); data[0].State.Status = 'running'; await service.reconcile();
  await assert.rejects(service.request('server-1', 'start', request('full')), /RESOURCE_EXHAUSTED/);
  data.pop(); assert.equal((await service.status('server-1', actor)).docker, 'missing');
});
test('timeout retains lock until underlying Docker operation settles', async () => {
  const { service } = setup({ delay: 1300, timeout: 1050 }); await service.reconcile();
  const { operation } = await service.request('server-0', 'start', request('slow'));
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(service.operation(operation.operationId, actor).state, 'timed_out');
  assert.ok(service.locks.has('server-0'));
  await settled(service, 'server-0'); assert.equal((await service.status('server-0', actor)).docker, 'running');
});

test('audit health survives Docker reconciliation and recovers only after failed records persist', async () => {
  const { service } = setup(); await service.reconcile();
  const events = [];
  service.audit.append = async event => {
    if (event.outcome !== 'accepted') throw new Error('private-disk-path');
    events.push(event);
  };
  const first = await service.request('server-0', 'start', request('audit-health'));
  await settled(service, 'server-0');
  await service.reconcile(); assert.equal(service.ready, false);
  assert.equal(service.operation(first.operation.operationId, actor).state, 'failed');
  await assert.rejects(service.request('server-1', 'start', request('blocked-audit')), /DOCKER_UNAVAILABLE/);
  service.audit.append = async event => events.push(event);
  await service.reconcile(); assert.equal(service.ready, true);
  assert.ok(events.some(event => event.outcome === 'failed'));
  assert.ok(!JSON.stringify(events).includes('private-disk-path'));
});

for (const action of ['start', 'stop']) test(`failed no-op ${action} completion audit replays sanitized failure`, async () => {
  const { service, data } = setup();
  if (action === 'start') data[0].State.Status = 'running';
  await service.reconcile();
  service.audit.append = async event => { if (event.outcome === 'completed') throw new Error('private-audit-error'); };
  await assert.rejects(service.request('server-0', action, request('failed-noop')), /DOCKER_UNAVAILABLE/);
  const replay = await service.request('server-0', action, request('failed-noop'));
  assert.equal(replay.operation.state, 'failed'); assert.equal(replay.operation.result, null);
  assert.equal(replay.operation.error, 'DOCKER_UNAVAILABLE');
  const id = replay.operation.operationId;
  await service.reconcile();
  assert.equal((await service.request('server-0', action, request('failed-noop'))).operation.operationId, id);
  assert.equal(service.operation(id, actor).state, 'failed');
});

for (const stage of ['inspection', 'reconciliation', 'audit']) test(`preflight deadline bounds stalled ${stage}, frees queue and prevents late mutation`, async () => {
  const { service, starts } = setup({ timeout: 1050 }); await service.reconcile();
  let release; const gate = new Promise(resolve => { release = resolve; });
  const inspect = service.docker.inspect.bind(service.docker);
  let calls = 0;
  if (stage === 'audit') service.audit.append = () => gate;
  else service.docker.inspect = async (...args) => {
    calls++;
    if (calls === (stage === 'inspection' ? 1 : 2)) await gate;
    return inspect(...args);
  };
  const first = service.request('server-0', 'start', request('stalled-first')).catch(error => error);
  const second = service.request('server-1', 'start', request('queued-second')).catch(error => error);
  let watchdog;
  try {
    const result = await Promise.race([Promise.all([first, second]), new Promise((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('Admission queue did not meet deadline')), 2000);
    })]);
    assert.equal(result[0].code, 'TIMEOUT'); assert.equal(result[1].code, 'DOCKER_UNAVAILABLE');
    assert.ok(service.locks.has('server-0')); assert.equal(starts(), 0);
  } finally { clearTimeout(watchdog); release(); await Promise.all([first, second]); }
  await settled(service, 'server-0'); assert.equal(starts(), 0);
});
