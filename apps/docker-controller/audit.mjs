import { appendFile, mkdir, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

// Append-only daily files. Retention deletion is an operator responsibility.
export class AuditLog {
  constructor(directory) { this.directory = directory; this.tail = Promise.resolve(); }
  async desiredStates(instances) {
    const desired = new Map(), approved = new Set(instances.map(e => e.id));
    let files;
    try { files = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return desired; throw error; }
    for (const file of files.filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort()) {
      const input = createReadStream(join(this.directory, file));
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          // Fail closed on damaged audit history; never guess an intended stop.
          const event = JSON.parse(line);
          if (approved.has(event.instanceId) && event.outcome === 'accepted' && ['start', 'stop'].includes(event.operation))
            desired.set(event.instanceId, event.operation === 'start' ? 'wanted_running' : 'wanted_stopped');
        }
      } finally { lines.close(); input.destroy(); }
    }
    return desired;
  }
  append(event) {
    const safe = { timestamp: event.timestamp, instanceId: event.instanceId, operation: event.operation, outcome: event.outcome, error: event.error };
    const write = this.tail.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await appendFile(join(this.directory, `${safe.timestamp.slice(0, 10)}.jsonl`), `${JSON.stringify(safe)}\n`, { mode: 0o600 });
    });
    this.tail = write.catch(() => {});
    return write;
  }
}
