import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundedHandler, hardenHttpServer } from '../libs/http-safety.mjs';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { harness, actor, request, deferred, until } from './phase2-harness.mjs';

test('HTTP handler bounds unsettled work and recovers after rejection', async () => {
  const gate = deferred(); let calls = 0;
  const handler = boundedHandler(async () => { calls++; await gate.promise; throw new Error('transport'); }, 1);
  const response = { status(code) { this.code = code; return this; }, json(value) { return value; } };
  const first = handler({}, response);
  const rejected = assert.rejects(first, /transport/);
  assert.deepEqual(await handler({}, response), { code: 'RESOURCE_EXHAUSTED' });
  assert.equal(response.code, 429); assert.equal(calls, 1);
  gate.resolve(); await rejected;
  await assert.rejects(handler({}, response), /transport/); assert.equal(calls, 2);
});

test('HTTP servers have explicit connection and slow-request limits', async () => {
  const app = await createApplication({}, ['s'.repeat(64)]);
  try {
    const server = app.getHttpServer();
    assert.equal(server.maxConnections, 128); assert.equal(server.maxRequestsPerSocket, 100);
    assert.equal(server.headersTimeout, 5000); assert.equal(server.requestTimeout, 10000);
    assert.equal(server.keepAliveTimeout, 5000); assert.equal(server.timeout, 30000);
  } finally { await app.close(); }
  for (const value of [0, -1, Infinity, 1.5]) assert.throws(() => boundedHandler(() => {}, value));
  let timeout;
  hardenHttpServer({ setTimeout(ms, callback) { timeout = callback; } });
  let destroyed = false; timeout({ destroy() { destroyed = true; } }); assert.equal(destroyed, true);
});

test('admission queue rejects excess work without Docker or audit side effects', async () => {
  const h = harness(); await h.service.reconcile(); h.service.maxPendingRequests = 1;
  const gate = deferred(); h.hooks.inspect = () => gate.promise;
  const first = h.service.request(h.instances[0].id, 'start', request());
  await until(() => h.service.locks.size === 1);
  const calls = h.calls.length;
  await assert.rejects(h.service.request(h.instances[1].id, 'start', request('second-request-0001')), { code: 'RESOURCE_EXHAUSTED' });
  assert.equal(h.calls.length, calls); assert.equal(h.events.length, 0);
  gate.resolve(); await first; await until(() => h.service.locks.size === 0);
  assert.equal(h.service.pendingRequests, 0);
  assert.equal((await h.service.request(h.instances[1].id, 'start', request('third-request-00001'))).status, 202);
  await until(() => h.service.locks.size === 0);
});

for (const action of ['start', 'stop']) test(`late execution inspection cannot begin ${action} after timeout`, async () => {
  const h = harness({ timeoutMs: 1100 });
  if (action === 'stop') h.data[0].State.Status = 'running';
  await h.service.reconcile();
  const gate = deferred(); let inspections = 0;
  // Admission start reconciles both instances before execution; stop does not.
  const executionInspection = action === 'start' ? 4 : 2;
  h.hooks.inspect = async () => { if (++inspections === executionInspection) await gate.promise; };
  const result = await h.service.request(h.instances[0].id, action, request());
  await until(() => h.service.operation(result.operation.operationId, actor).state === 'timed_out');
  assert.equal(h.service.locks.size, 1);
  gate.resolve(); await until(() => h.service.locks.size === 0);
  assert.equal(h.calls.filter(c => c[0] === action).length, 0);
  assert.equal(h.service.operation(result.operation.operationId, actor).state, 'timed_out');
});
