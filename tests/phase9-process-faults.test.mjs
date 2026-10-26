// Requirements: PLAN.md Phase 9 critical failure/recovery, RECOVERY.md and
// PHASE_6_BACKUP.md persistent ownership. No real Docker or existing data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const action of ['start', 'stop']) test(`controller survives ${action} cleanup failure without clearing persistent ownership`, { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/phase9/lock-release-child.mjs', import.meta.url)), action],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  const timer = setTimeout(() => child.kill(), 8000);
  let result;
  try {
    result = await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
  } finally { clearTimeout(timer); }
  assert.match(stdout, /release-fault-injected/, `fixture must reach the cleanup fault: ${stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, `cleanup must degrade readiness instead of terminating Node:\n${stderr}`);
  const status = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(status.alive, true); assert.equal(status.ready, false); assert.equal(status.locks, 1);
});
