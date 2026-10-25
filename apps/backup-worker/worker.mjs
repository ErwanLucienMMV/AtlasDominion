import { mkdir, writeFile, readdir, readFile, rm, lstat } from 'node:fs/promises';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireInstanceLock } from '../../libs/instance-lock.mjs';
import { validateRegistry } from '../../libs/server-registry/index.mjs';
import { createArchive, restoreArchive, verifyArchive } from './archive.mjs';

export function validateBackupConfig(config, instances) {
  validateRegistry(instances);
  if (!config || !isAbsolute(config.lockDirectory ?? '') || !Array.isArray(config.jobs) || !config.jobs.length) throw new Error('Invalid backup configuration');
  const ids = new Set(), paths = [];
  for (const job of config.jobs) {
    if (!instances.some(e => e.id === job.instanceId && e.adapter.backup === 'stopped-volume') || ids.has(job.instanceId) ||
      !isAbsolute(job.source ?? '') || !isAbsolute(job.destination ?? '') || !Number.isSafeInteger(job.intervalSeconds) || job.intervalSeconds < 60 ||
      !Number.isSafeInteger(job.keep) || job.keep < 1 || !Number.isSafeInteger(job.minimumFreeBytes) || job.minimumFreeBytes < 0 ||
      typeof job.allowRetentionDeletion !== 'boolean') throw new Error('Invalid backup job');
    ids.add(job.instanceId); paths.push(resolve(job.source), resolve(job.destination));
  }
  paths.push(resolve(config.lockDirectory));
  for (let a = 0; a < paths.length; a++) for (let b = a + 1; b < paths.length; b++) {
    if (paths[a] === paths[b] || paths[a].startsWith(paths[b] + sep) || paths[b].startsWith(paths[a] + sep)) throw new Error('Overlapping backup paths');
  }
  return structuredClone(config);
}
export class BackupWorker {
  constructor({ config, instances, docker, report = event => console.log(JSON.stringify(event)) }) {
    this.config = validateBackupConfig(config, instances); this.instances = validateRegistry(instances); this.docker = docker; this.report = report;
    this.active = false; this.last = new Map(); this.stopped = false;
  }
  async run(job) {
    const entry = this.instances.find(e => e.id === job.instanceId);
    let release;
    try {
      release = await acquireInstanceLock(this.config.lockDirectory, entry.id);
      const { data } = await this.docker.inspect(entry);
      const stopped = state => state.Status === 'exited' && state.ExitCode === 0 && !state.OOMKilled;
      if (!stopped(data.State)) throw new Error('Clean stopped server required');
      // The source must be an operator-approved mounted volume; container mount identity is checked too.
      if (!job.volumeName || !data.Mounts?.some(m => m.Type === 'volume' && m.Name === job.volumeName && m.Destination === job.containerPath)) throw new Error('Backup volume mismatch');
      const root = join(job.destination, entry.id);
      await mkdir(root, { recursive: true });
      if ((await lstat(root)).isSymbolicLink()) throw new Error('Unsafe archive root');
      const name = `${Date.now()}-${randomUUID()}`, archive = join(root, name);
      await createArchive(job.source, archive, entry.id, job.minimumFreeBytes);
      const after = await this.docker.inspect(entry, data.Id);
      if (!stopped(after.data.State)) throw new Error('Server state changed');
      const restored = join(archive, 'restore-test');
      await restoreArchive(archive, restored, entry.id);
      await rm(restored, { recursive: true });
      await writeFile(join(archive, 'verified.json'), JSON.stringify({ instanceId: entry.id, restoredAt: new Date().toISOString() }), { flag: 'wx' });
      await this.retain(root, job, name);
      this.report({ instanceId: entry.id, outcome: 'verified', archive: name });
      return archive;
    } catch (error) {
      this.report({ instanceId: entry.id, outcome: 'failed' }); throw error;
    } finally { if (release) await release(); }
  }
  async retain(root, job, replacement) {
    if (!job.allowRetentionDeletion) return;
    await verifyArchive(join(root, replacement), job.instanceId);
    const verified = [];
    for (const name of (await readdir(root)).sort().reverse()) {
      if (!/^\d{13}-[a-f0-9-]{36}$/.test(name) || (await lstat(join(root, name))).isSymbolicLink()) continue;
      try {
        const marker = JSON.parse(await readFile(join(root, name, 'verified.json'), 'utf8'));
        if (marker.instanceId !== job.instanceId) continue;
        await verifyArchive(join(root, name), job.instanceId); verified.push(name);
      } catch { /* Preserve damaged or incomplete evidence. */ }
    }
    for (const name of verified.slice(job.keep)) if (name !== replacement) await rm(join(root, name), { recursive: true });
  }
  async tick(now = Date.now()) {
    if (this.active || this.stopped) return;
    this.active = true;
    try {
      for (const job of this.config.jobs) {
        if (this.stopped) break;
        if (now - (this.last.get(job.instanceId) ?? -Infinity) < job.intervalSeconds * 1000) continue;
        this.last.set(job.instanceId, now);
        try { await this.run(job); } catch { /* Failure already reported; retry on next configured interval. */ }
      }
    } finally { this.active = false; }
  }
  start() { this.timer = setInterval(() => void this.tick(), 1000); void this.tick(); return this; }
  stop() { this.stopped = true; clearInterval(this.timer); }
}
