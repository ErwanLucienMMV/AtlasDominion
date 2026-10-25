// Labels come only from the validated registry and fixed enumerations.
const quote = value => JSON.stringify(String(value));
export class Monitoring {
  constructor() { this.observed = new Map(); this.outcomes = new Map(); this.durations = new Map(); this.finished = new WeakSet(); this.exits = new Map(); this.resources = new Map(); this.streamUp = false; this.lastReconcile = 0; this.samplingReady = false; this.lastSampling = 0; }
  observe(id, state, desired) {
    const previous = this.observed.get(id);
    if (previous === 'running' && ['exited', 'dead', 'missing'].includes(state) && desired !== 'wanted_stopped') {
      this.exits.set(id, (this.exits.get(id) ?? 0) + 1);
    }
    this.observed.set(id, state);
  }
  outcome(op) {
    // Failed completion persistence may retry finish(); count the operation once.
    if (this.finished.has(op)) return;
    this.finished.add(op);
    const key = `${op.instanceId}:${op.action}:${op.state}`;
    this.outcomes.set(key, (this.outcomes.get(key) ?? 0) + 1);
    const duration = (Date.parse(op.completedAt) - Date.parse(op.requestedAt)) / 1000;
    if (Number.isFinite(duration) && duration >= 0) this.durations.set(key, (this.durations.get(key) ?? 0) + duration);
  }
  render(service) {
    const lines = [];
    const emit = (name, value, labels = {}) => lines.push(`${name}${Object.keys(labels).length ? `{${Object.entries(labels).map(([k, v]) => `${k}=${quote(v)}`).join(',')}}` : ''} ${value}`);
    emit('atlas_controller_ready', Number(service.ready));
    emit('atlas_docker_events_connected', Number(this.streamUp));
    emit('atlas_reconcile_timestamp_seconds', this.lastReconcile);
    emit('atlas_resource_sampling_ready', Number(this.samplingReady));
    emit('atlas_resource_sampling_timestamp_seconds', this.lastSampling);
    emit('atlas_controller_active_operations', service.locks.size);
    emit('atlas_controller_audit_pending', service.failedAudits.size);
    for (const [resource, capacity] of Object.entries(service.capacity)) {
      const field = resource === 'memoryMiB' ? 'admissionMemoryMiB' : 'admissionCpuUnits';
      emit('atlas_capacity', capacity, { resource });
      emit('atlas_reserved', service.instances.filter(e => service.reservations.has(e.id)).reduce((n, e) => n + e.resources[field], 0), { resource });
    }
    for (const entry of service.instances) {
      const labels = { instance: entry.id, game_type: entry.gameType };
      emit('atlas_instance_info', 1, labels);
      const usage = this.resources.get(entry.id);
      if (usage) {
        emit('atlas_container_memory_bytes', usage.memory, labels);
        emit('atlas_container_cpu_seconds_total', usage.cpu, labels);
      }
      const state = this.observed.get(entry.id) ?? 'unknown';
      for (const candidate of ['created', 'running', 'exited', 'dead', 'missing', 'paused', 'restarting', 'removing', 'unknown'])
        emit('atlas_instance_state', Number(state === candidate), { ...labels, state: candidate });
      emit('atlas_instance_unexpected_exits_total', this.exits.get(entry.id) ?? 0, labels);
      emit('atlas_instance_wanted_running', Number(service.desired.get(entry.id) === 'wanted_running'), labels);
      const op = service.operations.get(service.locks.get(entry.id));
      emit('atlas_operation_age_seconds', op ? (Date.now() - Date.parse(op.requestedAt)) / 1000 : 0, labels);
    }
    for (const [key, count] of this.outcomes) {
      const [instance, action, outcome] = key.split(':');
      emit('atlas_operations_total', count, { instance, action, outcome });
      emit('atlas_operation_duration_seconds_count', count, { instance, action, outcome });
      emit('atlas_operation_duration_seconds_sum', this.durations.get(key) ?? 0, { instance, action, outcome });
    }
    return `${lines.join('\n')}\n`;
  }
}

// Events are hints only: inspect the approved registry, never trust event labels.
// Periodic reconciliation repairs event gaps; one pass at a time bounds work.
export class LifecycleObserver {
  constructor(service, client, { intervalMs = 15000, retryMs = 1000, sampleTimeoutMs = 5000 } = {}) {
    if (!Number.isSafeInteger(sampleTimeoutMs) || sampleTimeoutMs < 1 || sampleTimeoutMs > 2147483647) throw new Error('Invalid sample timeout');
    this.service = service; this.client = client; this.intervalMs = intervalMs; this.retryMs = retryMs;
    this.sampleTimeoutMs = sampleTimeoutMs; this.samples = new Map();
    this.stopped = true; this.pending = false;
  }
  async sample(entry) {
    // A deadline is not cancellation. Keep ownership until the underlying read
    // settles, even if a transport ignores abort, so polls cannot pile up reads.
    if (this.samples.has(entry.id)) throw new Error('Sample still pending');
    const controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = () => reject(new Error('Sample aborted')); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.sampleTimeoutMs);
    const work = Promise.resolve().then(async () => {
      const { container } = await this.service.docker.inspect(entry);
      if (this.stopped || controller.signal.aborted) throw new Error('Sample aborted');
      return container.stats({ stream: false, abortSignal: controller.signal });
    });
    const sample = { controller, work };
    this.samples.set(entry.id, sample);
    const release = () => { if (this.samples.get(entry.id) === sample) this.samples.delete(entry.id); };
    void work.then(release, release);
    try { return await Promise.race([work, aborted]); }
    finally { clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort); }
  }
  async refresh() {
    if (this.pending || this.stopped) return;
    this.pending = true;
    this.service.monitoring.samplingReady = false;
    try {
      await this.service.reconcile();
      // Once reconciliation succeeds, discard all old samples before any
      // sampling read can stall. Failed reconciliation retains prior evidence.
      this.service.monitoring.resources.clear();
      let healthy = true;
      for (const entry of this.service.instances) {
        if (this.stopped) return;
        this.service.monitoring.resources.delete(entry.id);
        if (this.service.monitoring.observed.get(entry.id) !== 'running') continue;
        try {
          const stats = await this.sample(entry);
          if (this.stopped) return;
          const memory = stats.memory_stats?.usage, cpu = stats.cpu_stats?.cpu_usage?.total_usage;
          if (!Number.isFinite(memory) || memory < 0 || !Number.isFinite(cpu) || cpu < 0) throw new Error('Invalid resource sample');
          this.service.monitoring.resources.set(entry.id, { memory, cpu: cpu / 1e9 });
        } catch { healthy = false; /* Omit unavailable samples rather than report zero usage. */ }
      }
      if (!this.stopped) {
        this.service.monitoring.samplingReady = healthy;
        this.service.monitoring.lastSampling = Date.now() / 1000;
      }
    } catch { if (!this.stopped) this.service.ready = false; }
    finally { this.pending = false; }
  }
  start() {
    this.stopped = false;
    this.timer = setInterval(() => void this.refresh(), this.intervalMs); this.timer.unref?.();
    void this.connect(); return this;
  }
  async connect() {
    try {
      const stream = await this.client.getEvents({ filters: { type: ['container'] } });
      if (this.stopped) { stream.destroy(); return; }
      this.stream = stream; this.service.monitoring.streamUp = true;
      let buffer = Buffer.alloc(0);
      stream.on('data', chunk => {
        if (this.stopped) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) {
          const end = bytes.indexOf(10, offset);
          const part = bytes.subarray(offset, end === -1 ? bytes.length : end);
          // Bound each frame, not the transport batch. Decode only complete
          // frames so a split UTF-8 character remains intact.
          if (buffer.length + part.length > 65536) { stream.destroy(); return; }
          buffer = Buffer.concat([buffer, part]);
          if (end === -1) return;
          try { if (JSON.parse(buffer.toString('utf8')).Type === 'container') void this.refresh(); } catch { stream.destroy(); return; }
          buffer = Buffer.alloc(0); offset = end + 1;
        }
      });
      let closed = false;
      const close = () => {
        if (closed) return; closed = true; this.service.monitoring.streamUp = false;
        stream.destroy(); this.retry();
      };
      stream.on('error', close); stream.on('end', close); stream.on('close', close);
      await this.refresh();
    } catch { this.service.monitoring.streamUp = false; this.retry(); }
  }
  retry() { if (!this.stopped) { this.retryTimer = setTimeout(() => void this.connect(), this.retryMs); this.retryTimer.unref?.(); } }
  stop() {
    this.stopped = true; clearInterval(this.timer); clearTimeout(this.retryTimer); this.stream?.destroy();
    for (const { controller } of this.samples.values()) controller.abort();
    this.service.monitoring.streamUp = false; this.service.monitoring.samplingReady = false;
    this.service.monitoring.resources.clear();
  }
}
