import { randomUUID, createHash } from 'node:crypto';
import { validateRegistry } from '../../libs/server-registry/index.mjs';
import { Fault, allowed, context } from './security.mjs';
import { Monitoring } from './monitoring.mjs';
import { acquireInstanceLock } from '../../libs/instance-lock.mjs';

const activeStates = new Set(['running', 'paused', 'restarting', 'removing']);
function verifyStopped(state, allowCreated = false) {
  if (!(state.Status === 'exited' || (allowCreated && state.Status === 'created')) || state.OOMKilled ||
    (state.ExitCode !== undefined && state.ExitCode !== 0)) throw new Fault('OPERATION_CONFLICT');
}
export class ControllerService {
  constructor({ instances, docker, policy, capacity, audit, timeoutMs, stopTimeoutSeconds, maxOperations = 10000, maxPendingRequests = 100, backupLockDirectory }) {
    if (!capacity || !Number.isFinite(capacity.memoryMiB) || capacity.memoryMiB <= 0 || !Number.isFinite(capacity.cpuUnits) || capacity.cpuUnits <= 0 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 || !Number.isSafeInteger(stopTimeoutSeconds) || stopTimeoutSeconds < 1 || timeoutMs <= stopTimeoutSeconds * 1000) throw new Error('Explicit capacity and timeouts required');
    if (![maxOperations, maxPendingRequests].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Positive operation and admission limits required');
    this.maxPendingRequests = maxPendingRequests; this.pendingRequests = 0;
    this.instances = validateRegistry(instances); this.docker = docker; this.policy = policy; this.capacity = capacity; this.audit = audit;
    this.timeoutMs = timeoutMs; this.stopTimeoutSeconds = stopTimeoutSeconds; this.maxOperations = maxOperations;
    this.locks = new Map(); this.reservations = new Set(); this.operations = new Map(); this.keys = new Map(); this.desired = new Map(); this.ready = false;
    this.admission = Promise.resolve();
    this.failedAudits = new Map();
    this.monitoring = new Monitoring();
    this.backupLockDirectory = backupLockDirectory; this.diskLocks = new Map(); this.failedReleases = new Set();
  }
  async unlock(id) {
    const release = this.diskLocks.get(id);
    if (release) {
      try { await release(); }
      catch {
        this.failedReleases.add(id); this.ready = false;
        throw new Fault('DOCKER_UNAVAILABLE');
      }
      this.diskLocks.delete(id);
    }
    this.failedReleases.delete(id);
    this.locks.delete(id);
  }
  authorize(id, actor) {
    context(actor);
    if (!allowed(this.policy, actor)) throw new Fault('FORBIDDEN');
    const entry = this.instances.find(e => e.id === id);
    if (!entry || !allowed(entry.policy, actor)) throw new Fault('UNKNOWN_INSTANCE');
    return entry;
  }
  async reconcile(wait = promise => promise) {
    this.ready = false;
    try {
      for (const entry of this.instances) {
        try {
          const { data } = await wait(this.docker.inspect(entry));
          this.monitoring.observe(entry.id, data.State.Status, this.desired.get(entry.id));
          if (activeStates.has(data.State.Status)) this.reservations.add(entry.id); else if (!this.locks.has(entry.id)) this.reservations.delete(entry.id);
        } catch (error) {
          if (error.code !== 'MISSING_CONTAINER') throw error;
          this.monitoring.observe(entry.id, 'missing', this.desired.get(entry.id));
          if (!this.locks.has(entry.id)) this.reservations.delete(entry.id);
        }
      }
      // Docker health cannot clear an unpersisted audit record. Retry the exact
      // sanitized records; only successful durable writes recover audit health.
      for (const [id, event] of this.failedAudits) {
        // A timed-out write may still append. Retry its terminal correction only
        // after that operation releases ownership, so late success cannot win.
        if (this.locks.get(event.instanceId) === id) continue;
        try {
          await wait(this.audit.append(event));
          if (this.failedAudits.get(id) === event) this.failedAudits.delete(id);
        } catch (error) { if (error.code === 'TIMEOUT') throw error; }
      }
      this.ready = this.failedAudits.size === 0 && this.failedReleases.size === 0;
      this.monitoring.lastReconcile = Date.now() / 1000;
    } catch (error) { this.ready = false; throw error; }
  }
  async status(id, actor) {
    const entry = this.authorize(id, actor);
    let state = 'missing', readiness = 'unknown';
    try {
      const { data } = await this.docker.inspect(entry); state = data.State.Status;
      readiness = state !== 'running' ? 'not_ready' : entry.adapter.readiness === 'unverified' ? 'unverified' :
        data.State.Health?.Status === 'healthy' ? 'ready' : data.State.Health ? 'not_ready' : 'unknown';
    } catch (error) { if (error.code !== 'MISSING_CONTAINER') throw error; }
    return { instanceId: id, displayName: entry.displayName, gameType: entry.gameType, desired: this.desired.get(id) ?? 'unknown',
      docker: state, readiness, observedAt: new Date().toISOString(), activeOperationId: this.locks.get(id) ?? null };
  }
  operation(id, actor) {
    const op = this.operations.get(id);
    if (!op) throw new Fault('UNKNOWN_INSTANCE');
    this.authorize(op.instanceId, actor); return structuredClone(op);
  }
  prune() {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, value] of this.keys) if (value.at < cutoff && !this.locks.has(value.instanceId)) {
      this.keys.delete(key); this.operations.delete(value.operationId);
    }
  }
  async request(id, action, request) {
    if (this.pendingRequests >= this.maxPendingRequests) throw new Fault('RESOURCE_EXHAUSTED');
    this.pendingRequests++;
    const pending = this.admission.then(() => this.requestLocked(id, action, request));
    this.admission = pending.catch(() => {});
    try { return await pending; }
    finally { this.pendingRequests--; }
  }
  async requestLocked(id, action, request) {
    if (!request || Object.keys(request).sort().join() !== 'authorization,idempotencyKey' ||
      typeof request.idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(request.idempotencyKey) || !['start', 'stop'].includes(action)) throw new Fault('INVALID_REQUEST');
    const entry = this.authorize(id, request.authorization);
    const key = createHash('sha256').update(`${id}:${request.idempotencyKey}`).digest('hex');
    this.prune();
    const previous = this.keys.get(key);
    if (previous) {
      if (previous.action !== action) throw new Fault('OPERATION_CONFLICT');
      return { status: ['completed', 'failed', 'timed_out'].includes(this.operations.get(previous.operationId).state) ? 200 : 202, operation: this.operation(previous.operationId, request.authorization) };
    }
    if (!this.ready) throw new Fault('DOCKER_UNAVAILABLE');
    if (this.locks.has(id)) throw new Fault('OPERATION_CONFLICT');
    if (this.operations.size >= this.maxOperations) throw new Fault('RESOURCE_EXHAUSTED');
    if (this.backupLockDirectory) {
      try { this.diskLocks.set(id, await acquireInstanceLock(this.backupLockDirectory, id)); }
      catch { throw new Fault('OPERATION_CONFLICT'); }
    }
    const op = { operationId: randomUUID(), instanceId: id, action, state: 'queued', requestedAt: new Date().toISOString(), completedAt: null, result: null, error: null };
    this.locks.set(id, op.operationId);
    const deadline = performance.now() + this.timeoutMs;
    const pending = new Set();
    let expired = false;
    const wait = async promise => {
      const tracked = Promise.resolve(promise);
      pending.add(tracked);
      let timer;
      try {
        const remaining = deadline - performance.now();
        if (expired || remaining <= 0) { expired = true; throw new Fault('TIMEOUT'); }
        const value = await Promise.race([tracked, new Promise((_, reject) => {
          timer = setTimeout(() => { expired = true; reject(new Fault('TIMEOUT')); }, remaining);
        })]);
        // A resolved dependency can run before an overdue timer callback when
        // synchronous work delays the event loop. Check elapsed time as well.
        if (performance.now() >= deadline) { expired = true; throw new Fault('TIMEOUT'); }
        return value;
      } finally {
        clearTimeout(timer);
        // Keep unresolved work visible for timeout cleanup without unhandled rejections.
        void tracked.then(() => pending.delete(tracked), () => pending.delete(tracked));
      }
    };
    try {
      const { data } = await wait(this.docker.inspect(entry));
      const already = action === 'start' ? data.State.Status === 'running' : ['exited', 'created'].includes(data.State.Status);
      if (action === 'stop' && already) verifyStopped(data.State, true);
      if (!already && !['running', 'exited', 'created'].includes(data.State.Status)) throw new Fault('OPERATION_CONFLICT');
      if (action === 'start' && !already) {
        // Await reconciliation while holding the instance lock, then reserve synchronously.
        await this.reconcile(wait);
        if (!this.ready) throw new Fault('DOCKER_UNAVAILABLE');
        const reserved = this.instances.filter(e => this.reservations.has(e.id) && e.id !== id);
        if (reserved.reduce((n, e) => n + e.resources.admissionMemoryMiB, entry.resources.admissionMemoryMiB) > this.capacity.memoryMiB ||
          reserved.reduce((n, e) => n + e.resources.admissionCpuUnits, entry.resources.admissionCpuUnits) > this.capacity.cpuUnits) throw new Fault('RESOURCE_EXHAUSTED');
        this.reservations.add(id);
      }
      await wait(this.record(op, 'accepted'));
      this.operations.set(op.operationId, op); this.keys.set(key, { operationId: op.operationId, action, instanceId: id, at: Date.now() });
      this.desired.set(id, action === 'start' ? 'wanted_running' : 'wanted_stopped');
      if (already) {
        op.result = action === 'start' ? 'already_running' : 'already_stopped';
        await this.finish(op, 'completed', wait); await this.unlock(id);
        return { status: 200, operation: structuredClone(op) };
      }
      // Do not retain caller identity or idempotency key in asynchronous work.
      void this.execute(entry, data.Id, op).catch(() => { this.ready = false; });
      return { status: 202, operation: structuredClone(op) };
    } catch (error) {
      if (expired) {
        this.ready = false;
        // Timeout is not cancellation. No preflight continuation can mutate
        // Docker; retain ownership until its outstanding dependency settles.
        void Promise.allSettled([...pending]).then(() => this.unlock(id)).catch(() => { this.ready = false; });
      } else if (!this.failedReleases.has(id)) await this.unlock(id);
      // Engine/identity failures require reconciliation before further admission.
      if (!(error instanceof Fault) || ['DOCKER_UNAVAILABLE', 'IDENTITY_MISMATCH', 'PORT_MISMATCH'].includes(error.code)) this.ready = false;
      throw error instanceof Fault ? error : new Fault('DOCKER_UNAVAILABLE');
    }
  }
  async record(op, outcome) {
    const event = { timestamp: new Date().toISOString(), instanceId: op.instanceId, operation: op.action, outcome, error: op.error };
    try {
      await this.audit.append(event);
      const previous = this.failedAudits.get(op.operationId);
      if (previous?.outcome === outcome && previous.error === op.error) this.failedAudits.delete(op.operationId);
    }
    catch {
      const terminalFailure = ['failed', 'timed_out'].includes(op.state);
      this.failedAudits.set(op.operationId, terminalFailure ? { ...event, outcome: op.state, error: op.error } : event); this.ready = false;
      throw new Fault('DOCKER_UNAVAILABLE');
    }
  }
  async finish(op, state, wait = promise => promise) {
    try {
      await wait(this.record(op, state));
      op.state = state; op.completedAt = new Date().toISOString();
      this.monitoring.outcome(op);
    } catch (error) {
      op.state = error.code === 'TIMEOUT' ? 'timed_out' : 'failed';
      op.result = null; op.error = error.code ?? 'DOCKER_UNAVAILABLE';
      op.completedAt = new Date().toISOString();
      this.monitoring.outcome(op);
      // Never later replay an undurable successful completion as success.
      this.failedAudits.set(op.operationId, { timestamp: op.completedAt, instanceId: op.instanceId, operation: op.action, outcome: op.state, error: op.error });
      this.ready = false; throw error;
    }
  }
  async execute(entry, pinnedId, op) {
    let timedOut = false;
    const deadline = performance.now() + this.timeoutMs, pending = new Set();
    const wait = async promise => {
      const tracked = Promise.resolve(promise);
      pending.add(tracked);
      void tracked.then(() => pending.delete(tracked), () => pending.delete(tracked));
      let timer;
      const remaining = deadline - performance.now();
      if (timedOut || remaining <= 0) { timedOut = true; throw new Fault('TIMEOUT'); }
      try {
        const value = await Promise.race([tracked, new Promise((_, reject) => {
          timer = setTimeout(() => { timedOut = true; reject(new Fault('TIMEOUT')); }, remaining);
        })]);
        if (performance.now() >= deadline) { timedOut = true; throw new Fault('TIMEOUT'); }
        return value;
      } finally { clearTimeout(timer); }
    };
    const work = (async () => {
      const { container } = await this.docker.inspect(entry, pinnedId);
      // A transport deadline cannot cancel an inspection. Never begin a new
      // mutation when that inspection returns after the operation timed out.
      if (timedOut || performance.now() >= deadline) throw new Fault('TIMEOUT');
      op.state = op.action === 'start' ? 'starting' : 'stopping';
      try { if (op.action === 'start') await container.start(); else await container.stop({ t: this.stopTimeoutSeconds }); }
      catch (error) { if (error.statusCode !== 304) throw new Fault('DOCKER_UNAVAILABLE'); }
      const { data } = await this.docker.inspect(entry, pinnedId);
      if (op.action === 'start') {
        if (data.State.Status !== 'running') throw new Fault('OPERATION_CONFLICT');
      } else verifyStopped(data.State);
      if (op.action === 'stop') this.reservations.delete(entry.id); else this.reservations.add(entry.id);
    })();
    try {
      await wait(work);
      op.result = 'changed'; await this.finish(op, 'completed', wait);
    } catch (error) {
      op.error = error instanceof Fault ? error.code : 'DOCKER_UNAVAILABLE'; this.ready = false;
      if (!['failed', 'timed_out'].includes(op.state)) {
        if (timedOut || op.error === 'TIMEOUT') {
          op.state = 'timed_out'; op.result = null; op.completedAt = new Date().toISOString();
          this.monitoring.outcome(op);
          this.failedAudits.set(op.operationId, { timestamp: op.completedAt, instanceId: op.instanceId, operation: op.action, outcome: op.state, error: op.error });
          // Engine timeout has no outstanding success write. Persist failure
          // immediately, while retaining the lock for this write and the Engine.
          const persistence = this.record(op, 'timed_out');
          pending.add(persistence);
          void persistence.then(() => pending.delete(persistence), () => pending.delete(persistence));
        } else {
          try { await this.finish(op, 'failed', wait); } catch { this.ready = false; }
        }
      }
    } finally {
      // Neither Engine nor filesystem work is cancelled by a deadline. Keep
      // ownership until both settle, then persist any terminal correction.
      await Promise.allSettled([...pending]);
      // Cleanup failure is separate from the persisted Engine outcome. Keep
      // ownership and readiness degraded; never let detached work reject Node.
      try { await this.unlock(entry.id); } catch { this.ready = false; }
      try { await this.reconcile(); } catch { this.ready = false; }
    }
  }
}
