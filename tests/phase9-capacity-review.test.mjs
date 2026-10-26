import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, request, until } from './phase2-harness.mjs';

// Model a dependency whose synchronous work delays the event loop past the
// preflight deadline. A promise resolution must not outrun an overdue timer.
for (const phase of ['before wait', 'during wait']) for (const action of ['start', 'stop']) test(`expired preflight ${phase} cannot admit ${action}`, async () => {
  const h = harness({ timeoutMs: 1050 });
  if (action === 'stop') h.data[0].State.Status = 'running';
  await h.service.reconcile();
  let first = true;
  h.hooks.inspect = async () => {
    if (!first) return;
    first = false;
    if (phase === 'during wait') await Promise.resolve();
    const end = performance.now() + 1100;
    while (performance.now() < end) { /* Simulated synchronous dependency. */ }
  };
  await assert.rejects(h.service.request('edge-0', action, request()), { code: 'TIMEOUT' });
  await until(() => h.service.locks.size === 0);
  assert.equal(h.service.pendingRequests, 0);
  assert.equal(h.service.operations.size, 0);
  assert.equal(h.events.length, 0);
  assert.equal(h.calls.filter(call => ['start', 'stop'].includes(call[0])).length, 0);
  assert.equal(h.data[0].State.Status, action === 'start' ? 'exited' : 'running');
  assert.equal(h.service.ready, false);

  // Timeout does not poison admission: explicit reconciliation and fresh work
  // recover without clearing ownership or fabricating an operation result.
  h.hooks.inspect = null;
  await h.service.reconcile();
  const result = await h.service.request('edge-0', action, request('recovered-request-0001'));
  assert.equal(result.status, 202);
  await until(() => h.service.locks.size === 0);
  assert.equal(h.service.operation(result.operation.operationId, request().authorization).state, 'completed');
  assert.equal(h.calls.filter(call => call[0] === action).length, 1);
});
