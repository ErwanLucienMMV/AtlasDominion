import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// Append-only daily files. Retention deletion is an operator responsibility.
export class AuditLog {
  constructor(directory) { this.directory = directory; this.tail = Promise.resolve(); }
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
