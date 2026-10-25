import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog } from '../apps/docker-controller/audit.mjs';
import { LifecycleObserver, Monitoring } from '../apps/docker-controller/monitoring.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const record = { timestamp: '2026-10-25T12:00:00.000Z', instanceId: 'approved', operation: 'stop', outcome: 'accepted', error: null };
function gate() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }
function service() {
  return { instances: [{ id: 'approved' }, { id: 'second' }], monitoring: new Monitoring(), ready: true,
    reconcile: async () => {}, docker: { inspect: async () => ({ container: { stats: async () => ({ memory_stats: { usage: 0 }, cpu_stats: { cpu_usage: { total_usage: 0 } } }) } }) } };
}

test('audit replay validates every required field and preserves damaged history verbatim', async () => {
  const invalid = [null, [], 42, {}, ...[
    ['timestamp', false], ['timestamp', '2026-02-30T00:00:00Z'], ['timestamp', '2026-10-25'],
    ['instanceId', null], ['instanceId', '../foreign'], ['operation', 42], ['outcome', 'invented'], ['error', {}], ['error', 'raw private message'],
  ].map(([key, value]) => ({ ...record, [key]: value }))];
  for (const key of Object.keys(record)) { const missing = { ...record }; delete missing[key]; invalid.push(missing); }
  for (const event of invalid) {
    const directory = await mkdtemp(join(tmpdir(), 'atlas-p5-record-'));
    const file = join(directory, '2026-10-25.jsonl'), text = `${JSON.stringify(event)}\n`;
    await writeFile(file, text);
    await assert.rejects(new AuditLog(directory).desiredStates([{ id: 'approved' }]));
    assert.equal(await readFile(file, 'utf8'), text);
  }
});

test('valid historical records with second precision, other instances and operations remain readable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atlas-p5-history-'));
  const records = [record, { ...record, timestamp: '2026-10-25T12:00:01Z', operation: 'start' },
    { ...record, operation: 'exec' }, { ...record, instanceId: 'foreign' }, { ...record, outcome: 'failed', error: 'TIMEOUT' }];
  await writeFile(join(directory, '2026-10-25.jsonl'), records.map(e => JSON.stringify(e)).join('\n') + '\n');
  assert.deepEqual([...await new AuditLog(directory).desiredStates([{ id: 'approved' }])], [['approved', 'wanted_running']]);
});

test('frame bounds apply to complete and partial byte frames, including split UTF-8', async () => {
  for (const oversized of [false, true]) {
    const stream = new PassThrough(), stub = service(); stub.instances = [];
    const observer = new LifecycleObserver(stub, { getEvents: async () => stream }, { intervalMs: 100000, retryMs: 100000 });
    let frames = 0; observer.refresh = async () => { frames++; }; observer.start();
    try {
      await tick(); const baseline = frames;
      const head = '{"Type":"container","note":"', tail = '"}';
      const frame = head + 'a'.repeat(65536 - Buffer.byteLength(head + tail) + Number(oversized)) + tail;
      stream.write(frame + '\n'); await tick();
      assert.equal(stream.destroyed, oversized);
      if (!oversized) {
        const unicode = Buffer.from('{"Type":"container","note":"é"}\n');
        const split = unicode.indexOf(Buffer.from('é')) + 1;
        stream.write(unicode.subarray(0, split)); stream.write(unicode.subarray(split));
        stream.write('{"Type":"container"}\n'.repeat(5000)); await tick();
        assert.equal(stream.destroyed, false); assert.equal(frames, baseline + 5002);
      }
    } finally { observer.stop(); }
  }
});

for (const stage of ['reconcile', 'inspect', 'stats']) test(`shutdown during ${stage} prevents further sampling and late metric publication`, async () => {
  const stub = service(), blocked = gate(), entered = gate(); const calls = [];
  stub.monitoring.observed.set('approved', 'running'); stub.monitoring.observed.set('second', 'running');
  const pause = async name => { if (stage === name) { entered.release(); await blocked.promise; } };
  stub.reconcile = async () => pause('reconcile');
  stub.docker.inspect = async entry => {
    calls.push(`inspect:${entry.id}`); await pause('inspect');
    return { container: { stats: async () => { calls.push(`stats:${entry.id}`); await pause('stats'); return { memory_stats: { usage: 10 }, cpu_stats: { cpu_usage: { total_usage: 20 } } }; } } };
  };
  const observer = new LifecycleObserver(stub, {}); observer.stopped = false;
  const pending = observer.refresh(); await entered.promise; observer.stop();
  const atStop = [...calls]; blocked.release(); await pending;
  assert.deepEqual(calls, atStop); assert.equal(stub.monitoring.resources.size, 0); assert.equal(observer.pending, false);
});

test('resource sampling accepts zero but omits negative memory or CPU', async () => {
  for (const [memory, cpu, accepted] of [[0, 0, true], [1, 2e9, true], [-1, 1, false], [1, -1, false]]) {
    const stub = service(); stub.monitoring.observed.set('approved', 'running');
    stub.docker.inspect = async () => ({ container: { stats: async () => ({ memory_stats: { usage: memory }, cpu_stats: { cpu_usage: { total_usage: cpu } } }) } });
    const observer = new LifecycleObserver(stub, {}); observer.stopped = false; await observer.refresh();
    assert.equal(stub.monitoring.resources.has('approved'), accepted);
    if (accepted) assert.deepEqual(stub.monitoring.resources.get('approved'), { memory, cpu: cpu / 1e9 });
  }
});
