// Requirements: SECURITY.md, docs/PHASE_9_HARDENING.md and docs/PHASE_2_CONTROLLER.md.
// All Engine mutations are in-memory fakes; no daemon, network deployment or existing data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { verifyIdentity } from '../apps/docker-controller/docker.mjs';
import { boundedHandler } from '../libs/http-safety.mjs';
import { harness, actor, policy, request, deferred, until, manifest, inspection } from './phase2-harness.mjs';

function construct(overrides) {
  const h = harness();
  return new ControllerService({ instances: h.instances, docker: h.service.docker, policy: policy(),
    capacity: { memoryMiB: 1000, cpuUnits: 10 }, audit: h.service.audit,
    timeoutMs: 2000, stopTimeoutSeconds: 1, ...overrides });
}

for (const field of ['maxPendingRequests', 'maxOperations']) {
  for (const value of [0, -1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
    test(`configuration rejects ${field}=${String(value)} (${typeof value})`, () => {
      assert.throws(() => construct({ [field]: value }));
    });
  }
}

for (const timeoutMs of [2147483648, 4294967296, Number.MAX_SAFE_INTEGER]) {
  test(`configuration rejects timeout ${timeoutMs} that Node clamps to one millisecond`, () => {
    assert.throws(() => construct({ timeoutMs }), /timeout|configuration|limit/i);
  });
}
test('largest representable Node timer is accepted without scheduling work', () => {
  assert.doesNotThrow(() => construct({ timeoutMs: 2147483647 }));
});

for (const source of ['/var', '/var/lib', '/var/lib/../lib']) {
  test(`SECURITY: parent bind ${source} cannot expose Docker storage through a child path`, () => {
    const entry = manifest(), data = inspection(entry);
    data.Config.User = '1000:1000';
    data.Mounts = [{ Type: 'bind', Source: source, Destination: '/host-data', RW: true }];
    assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']), { code: 'IDENTITY_MISMATCH' });
  });
}

for (const [name, mutate] of Object.entries({
  privileged: d => { d.HostConfig.Privileged = true; },
  hostNetwork: d => { d.HostConfig.NetworkMode = 'host'; },
  sharedNetwork: d => { d.HostConfig.NetworkMode = 'container:another'; },
  hostPid: d => { d.HostConfig.PidMode = 'host'; },
  sharedIpc: d => { d.HostConfig.IpcMode = 'container:another'; },
  capability: d => { d.HostConfig.CapAdd = ['SYS_ADMIN']; },
  noCapabilityDrop: d => { delete d.HostConfig.CapDrop; },
  falsePrivilege: d => { d.HostConfig.SecurityOpt.push('no-new-privileges=false'); },
  unconfined: d => { d.HostConfig.SecurityOpt.push('seccomp=unconfined'); },
  root: d => { d.Config.User = '0:1000'; },
  socket: d => { d.Mounts = [{ Type: 'bind', Source: '/srv/docker.sock', Destination: '/data' }]; },
  managementAttachment: d => { d.NetworkSettings = { Networks: { 'atlas-control': {} } }; },
  wrongLabel: d => { d.Config.Labels['io.atlasdominion.instance'] = 'another'; },
  automaticRestart: d => { d.HostConfig.RestartPolicy.Name = 'always'; },
  unlistedPort: d => { d.HostConfig.PortBindings['2375/tcp'] = [{ HostIp: '127.0.0.1', HostPort: '2375' }]; },
  wildcardBind: d => { d.HostConfig.PortBindings['7777/udp'][0].HostIp = '0.0.0.0'; },
})) test(`identity guard rejects ${name}`, () => {
  const entry = manifest(), data = inspection(entry); data.Config.User = '1000:1000'; mutate(data);
  assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']));
});

for (const kind of ['throw', 'reject', 'fulfill']) test(`HTTP admission recovers after synchronous/asynchronous ${kind}`, async () => {
  const response = { status(code) { this.code = code; return this; }, json(value) { return value; } };
  const gate = deferred(); let calls = 0;
  const handler = boundedHandler(function () {
    assert.equal(this.marker, 42); calls++;
    if (kind === 'throw') throw new Error('synthetic failure');
    return gate.promise.then(() => { if (kind === 'reject') throw new Error('synthetic failure'); return 42; });
  }, 1).bind({ marker: 42 });
  const first = handler({}, response);
  const outcome = kind === 'fulfill' ? first : assert.rejects(first, /synthetic failure/);
  if (kind !== 'throw') {
    assert.deepEqual(await handler({}, response), { code: 'RESOURCE_EXHAUSTED' });
    assert.equal(response.code, 429); assert.equal(calls, 1);
  }
  gate.resolve(); await outcome;
  if (kind === 'fulfill') assert.equal(await handler({}, response), 42);
  else await assert.rejects(handler({}, response), /synthetic failure/);
  assert.equal(calls, 2);
});

test('100 concurrent identical operations produce one accepted audit and one Engine mutation', async () => {
  const h = harness(); await h.service.reconcile();
  const gate = deferred(); h.hooks.start = () => gate.promise;
  try {
    const results = await Promise.all(Array.from({ length: 100 }, () => h.service.request(h.instances[0].id, 'start', request())));
    assert.equal(new Set(results.map(r => r.operation.operationId)).size, 1);
    assert.equal(h.calls.filter(c => c[0] === 'start').length, 1);
    assert.equal(h.events.filter(e => e.outcome === 'accepted').length, 1);
    assert.equal(h.service.pendingRequests, 0);
  } finally { gate.resolve(); await until(() => h.service.locks.size === 0); }
});

test('mixed-instance burst never overcommits a one-instance memory and CPU budget', async () => {
  const h = harness({ count: 20, capacity: { memoryMiB: 100, cpuUnits: 1 } }); await h.service.reconcile();
  const gate = deferred(); h.hooks.start = () => gate.promise;
  try {
    const results = await Promise.allSettled(h.instances.map((entry, i) => h.service.request(entry.id, 'start', request(`unique-admission-${i}`))));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.filter(r => r.status === 'rejected').every(r => r.reason.code === 'RESOURCE_EXHAUSTED'));
    assert.equal(h.calls.filter(c => c[0] === 'start').length, 1);
    assert.equal(h.service.reservations.size, 1); assert.equal(h.service.pendingRequests, 0);
  } finally { gate.resolve(); await until(() => h.service.locks.size === 0); }
});

test('invalid queued requests release every pending admission slot without Engine access', async () => {
  const h = harness(); await h.service.reconcile(); const before = h.calls.length;
  const results = await Promise.allSettled(Array.from({ length: 100 }, () => h.service.request(h.instances[0].id, 'start', {})));
  assert.ok(results.every(r => r.status === 'rejected' && r.reason.code === 'INVALID_REQUEST'));
  assert.equal(h.service.pendingRequests, 0); assert.equal(h.service.locks.size, 0);
  assert.equal(h.calls.length, before); assert.equal(h.events.length, 0);
  await h.service.request(h.instances[0].id, 'start', request()); await until(() => h.service.locks.size === 0);
});

for (const action of ['start', 'stop']) test(`DEADLINE: stalled terminal audit bounds ${action} completion and never publishes late success`, async () => {
  const h = harness({ timeoutMs: 1050 });
  if (action === 'stop') h.data[0].State.Status = 'running';
  await h.service.reconcile();
  const gate = deferred(), entered = deferred();
  h.hooks.audit = async event => { if (event.outcome === 'completed') { entered.resolve(); await gate.promise; } };
  const result = await h.service.request(h.instances[0].id, action, request());
  await entered.promise;
  let stateAtDeadline;
  try {
    await delay(1250);
    stateAtDeadline = h.service.operation(result.operation.operationId, actor).state;
    assert.equal(h.service.locks.size, 1, 'unsettled filesystem work must retain instance ownership');
  } finally { gate.resolve(); await until(() => h.service.locks.size === 0); }
  assert.deepEqual({ atDeadline: stateAtDeadline, afterRelease: h.service.operation(result.operation.operationId, actor).state },
    { atDeadline: 'timed_out', afterRelease: 'timed_out' }, 'terminal audit must have a deadline and cannot publish late success');
});

test('late Engine failure after timeout cannot become success or mutate a replacement instance', async () => {
  const h = harness({ timeoutMs: 1050 }); await h.service.reconcile();
  const gate = deferred(); h.hooks.start = async () => { await gate.promise; throw new Error('PRIVATE_ENGINE_SENTINEL'); };
  const result = await h.service.request(h.instances[0].id, 'start', request());
  try {
    await until(() => h.service.operation(result.operation.operationId, actor).state === 'timed_out');
    await h.service.reconcile();
    await assert.rejects(h.service.request(h.instances[0].id, 'stop', request('late-opposite-action')), { code: 'OPERATION_CONFLICT' });
  } finally { gate.resolve(); await until(() => h.service.locks.size === 0); }
  const op = h.service.operation(result.operation.operationId, actor);
  assert.equal(op.state, 'timed_out'); assert.equal(op.error, 'TIMEOUT');
  assert.equal(h.events.filter(e => e.outcome === 'completed').length, 0);
  assert.doesNotMatch(JSON.stringify(h.events), /PRIVATE_ENGINE_SENTINEL/);
});
