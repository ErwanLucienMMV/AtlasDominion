import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleObserver, Monitoring } from '../apps/docker-controller/monitoring.mjs';

for (const option of ['intervalMs', 'retryMs']) {
  for (const value of [0, -1, 0.5, NaN, Infinity, '1000', null, 2147483648, Number.MAX_SAFE_INTEGER]) {
    test(`monitoring rejects unsafe ${option}: ${String(value)}`, () => {
      assert.throws(() => new LifecycleObserver({}, {}, { [option]: value }), /Invalid (reconciliation interval|event retry delay)/);
    });
  }
}

test('monitoring accepts timer boundaries without scheduling long-running work', () => {
  for (const value of [1, 2147483647]) {
    const observer = new LifecycleObserver({}, {}, { intervalMs: value, retryMs: value });
    assert.equal(observer.intervalMs, value);
    assert.equal(observer.retryMs, value);
    assert.equal(observer.stopped, true);
  }
  const defaults = new LifecycleObserver({}, {});
  assert.equal(defaults.intervalMs, 15000);
  assert.equal(defaults.retryMs, 1000);
});

test('failed event connection retries at the configured delay and shutdown cancels recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const observer = new LifecycleObserver({ monitoring: new Monitoring() }, {
    getEvents: async () => { throw new Error('synthetic event outage'); },
  }, { retryMs: 700 });
  observer.stopped = false;
  await observer.connect();
  assert.equal(observer.service.monitoring.streamUp, false);
  let reconnects = 0;
  observer.connect = async () => { reconnects++; };
  t.after(() => observer.stop());
  t.mock.timers.tick(699);
  assert.equal(reconnects, 0);
  t.mock.timers.tick(1);
  assert.equal(reconnects, 1);
  observer.retry();
  observer.stop();
  t.mock.timers.tick(700);
  assert.equal(reconnects, 1);
});

test('reconciliation failure preserves last evidence and a healthy later pass restores sampling', async () => {
  const monitoring = new Monitoring();
  const entry = { id: 'recovery-world' };
  let unavailable = false;
  const service = {
    instances: [entry], monitoring, ready: true,
    reconcile: async () => {
      if (unavailable) throw new Error('synthetic daemon outage');
      service.ready = true;
      monitoring.observe(entry.id, 'running', 'wanted_running');
    },
    docker: { inspect: async () => ({ container: { stats: async () => ({
      memory_stats: { usage: 128 }, cpu_stats: { cpu_usage: { total_usage: 3e9 } },
    }) } }) },
  };
  const observer = new LifecycleObserver(service, {});
  observer.stopped = false;
  try {
    await observer.refresh();
    const priorTimestamp = monitoring.lastSampling;
    unavailable = true;
    await observer.refresh();
    assert.equal(service.ready, false);
    assert.equal(monitoring.samplingReady, false);
    assert.equal(monitoring.lastSampling, priorTimestamp);
    assert.deepEqual(monitoring.resources.get(entry.id), { memory: 128, cpu: 3 });
    unavailable = false;
    await observer.refresh();
    assert.equal(service.ready, true);
    assert.equal(monitoring.samplingReady, true);
    assert.deepEqual(monitoring.resources.get(entry.id), { memory: 128, cpu: 3 });
    assert.equal(monitoring.exits.size, 0);
    assert.equal(observer.pending, false);
  } finally { observer.stop(); }
});
