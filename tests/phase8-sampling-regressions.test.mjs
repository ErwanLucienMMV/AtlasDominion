import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { LifecycleObserver, Monitoring } from '../apps/docker-controller/monitoring.mjs';
import { fleet, harness } from './phase8-harness.mjs';

const stats = { memory_stats: { usage: 64 }, cpu_stats: { cpu_usage: { total_usage: 2e9 } } };
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(options = {}) {
  const instances = fleet(3), calls = [], hooks = {};
  const monitoring = new Monitoring();
  for (const entry of instances) monitoring.observed.set(entry.id, 'running');
  const service = { instances, monitoring, ready: true, reconcile: async () => {},
    docker: { inspect: async entry => {
      calls.push(['inspect', entry.id]);
      if (hooks.inspect && entry.id === 'nebula-00') await hooks.inspect();
      return { container: { stats: async options => {
        calls.push(['stats', entry.id, options]);
        return hooks.stats && entry.id === 'nebula-00' ? hooks.stats(options) : stats;
      } } };
    } }
  };
  const observer = new LifecycleObserver(service, {}, { sampleTimeoutMs: 20, ...options }); observer.stopped = false;
  return { service, observer, calls, hooks, monitoring };
}

test('hung stats reaches a deadline, samples later servers and exposes degradation independently of lifecycle health', { timeout: 5000 }, async t => {
  const h = await harness(t, fleet(3));
  for (const data of h.states.values()) data.State.Status = 'running';
  const observer = new LifecycleObserver(h.service, {}, { sampleTimeoutMs: 20 }); observer.stopped = false;
  t.after(() => observer.stop());
  await observer.refresh(); assert.equal(h.service.monitoring.resources.size, 3);
  const gate = deferred(), entered = deferred(), inspect = h.docker.inspect.bind(h.docker);
  t.after(() => gate.resolve(stats));
  let attempts = 0, signal;
  h.docker.inspect = async (...args) => {
    const result = await inspect(...args);
    if (args[0].id === 'nebula-00') result.container.stats = options => {
      attempts++; signal = options.abortSignal; entered.resolve(); return gate.promise;
    };
    return result;
  };
  const refresh = observer.refresh(); await entered.promise;
  assert.equal(h.service.monitoring.resources.size, 0, 'Stale samples disappear before the first sample can stall');
  await refresh;
  assert.equal(observer.pending, false); assert.equal(signal.aborted, true);
  assert.equal(observer.samples.size, 1, 'Unsettled transport retains ownership after timeout');
  assert.deepEqual([...h.service.monitoring.resources.keys()], ['nebula-01', 'nebula-02']);
  const response = await fetch(`${await h.app.getUrl()}/metrics`, { headers: { authorization: `Bearer ${h.secret}` } });
  const metrics = await response.text(); assert.equal(response.status, 200);
  assert.match(metrics, /atlas_resource_sampling_ready 0\n/);
  assert.match(metrics, /atlas_resource_sampling_timestamp_seconds [1-9]/);
  const health = await fetch(`${await h.app.getUrl()}/v1/health`, { headers: { authorization: `Bearer ${h.secret}` } });
  assert.deepEqual(await health.json(), { ready: true });
  for (let i = 0; i < 20; i++) await observer.refresh();
  assert.equal(attempts, 1, 'Repeated polls cannot accumulate requests for a stuck instance');
  assert.equal(observer.samples.size, 1);
  gate.resolve(stats); await tick();
  assert.equal(observer.samples.size, 0);
  assert.equal(h.service.monitoring.resources.has('nebula-00'), false, 'Late successful result must not publish');
  h.docker.inspect = inspect; await observer.refresh();
  assert.equal(h.service.monitoring.samplingReady, true);
  assert.equal(h.service.monitoring.resources.size, 3);
});

for (const stage of ['inspect', 'stats']) test(`timed-out sampling ${stage} cannot start duplicate reads or publish after settlement`, { timeout: 5000 }, async t => {
  const h = setup(), gate = deferred(); t.after(() => { gate.resolve(stats); h.observer.stop(); });
  h.hooks[stage] = () => gate.promise;
  await h.observer.refresh();
  assert.deepEqual([...h.monitoring.resources.keys()], ['nebula-01', 'nebula-02']);
  assert.equal(h.monitoring.samplingReady, false);
  for (let i = 0; i < 10; i++) await h.observer.refresh();
  assert.equal(h.calls.filter(c => c[0] === stage && c[1] === 'nebula-00').length, 1);
  gate.resolve(stats); await tick();
  assert.equal(h.observer.samples.size, 0);
  if (stage === 'inspect') assert.equal(h.calls.filter(c => c[0] === 'stats' && c[1] === 'nebula-00').length, 0);
  assert.equal(h.monitoring.resources.has('nebula-00'), false);
  delete h.hooks[stage]; await h.observer.refresh();
  assert.equal(h.monitoring.samplingReady, true); assert.equal(h.monitoring.resources.size, 3);
});

test('late rejection is consumed and the following poll recovers', { timeout: 5000 }, async t => {
  const h = setup(), gate = deferred(); t.after(() => h.observer.stop());
  h.hooks.stats = () => gate.promise;
  await h.observer.refresh(); gate.reject(new Error('private late transport failure')); await tick();
  assert.equal(h.observer.samples.size, 0); assert.equal(h.monitoring.resources.has('nebula-00'), false);
  delete h.hooks.stats; await h.observer.refresh();
  assert.equal(h.monitoring.samplingReady, true);
});

test('abort-aware stats transport is cancelled at the sample deadline', { timeout: 5000 }, async t => {
  const h = setup(); t.after(() => h.observer.stop());
  let aborted = false;
  h.hooks.stats = ({ abortSignal }) => new Promise((_, reject) => {
    abortSignal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true });
  });
  await h.observer.refresh(); await tick();
  assert.equal(aborted, true); assert.equal(h.observer.samples.size, 0);
  assert.equal(h.monitoring.resources.size, 2);
});

test('shutdown releases the observer promptly even if stats ignores abort', { timeout: 5000 }, async t => {
  const h = setup({ sampleTimeoutMs: 60000 }), gate = deferred(), entered = deferred();
  t.after(() => { gate.resolve(stats); h.observer.stop(); });
  h.hooks.stats = () => { entered.resolve(); return gate.promise; };
  const refresh = h.observer.refresh(); await entered.promise; h.observer.stop(); await refresh;
  assert.equal(h.observer.pending, false); assert.equal(h.monitoring.samplingReady, false);
  assert.equal(h.calls.filter(c => c[0] === 'stats').length, 1);
  gate.resolve(stats); await tick();
  assert.equal(h.monitoring.resources.size, 0); assert.equal(h.observer.samples.size, 0);
});

test('a rejected or invalid sample degrades sampling without falsifying lifecycle readiness', async () => {
  const h = setup();
  for (const sample of [null, {}, { memory_stats: { usage: NaN } }]) {
    h.hooks.stats = () => sample; await h.observer.refresh();
    assert.equal(h.monitoring.samplingReady, false); assert.equal(h.service.ready, true);
    assert.equal(h.monitoring.resources.size, 2);
  }
  h.hooks.stats = () => { throw new Error('private diagnostic'); }; await h.observer.refresh();
  assert.equal(h.monitoring.samplingReady, false);
  delete h.hooks.stats; await h.observer.refresh(); assert.equal(h.monitoring.samplingReady, true);
});

test('reconciliation failure preserves prior evidence and sampling timestamp but marks sampling unready', async () => {
  const h = setup(); await h.observer.refresh();
  const timestamp = h.monitoring.lastSampling, resources = [...h.monitoring.resources];
  h.service.reconcile = async () => { throw new Error('daemon unavailable'); };
  await h.observer.refresh();
  assert.equal(h.monitoring.samplingReady, false); assert.equal(h.service.ready, false);
  assert.equal(h.monitoring.lastSampling, timestamp); assert.deepEqual([...h.monitoring.resources], resources);
});

for (const sampleTimeoutMs of [0, -1, 1.5, NaN, Infinity, '20', 2147483648])
  test(`invalid sampling deadline is rejected: ${sampleTimeoutMs}`, () => {
    assert.throws(() => setup({ sampleTimeoutMs }), /Invalid sample timeout/);
  });
