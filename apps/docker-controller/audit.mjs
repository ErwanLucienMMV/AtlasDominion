import { open, mkdir, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

function validateRecord(event) {
  const timestamp = event?.timestamp;
  if (!event || typeof event !== 'object' || Array.isArray(event) ||
    typeof timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== (timestamp.includes('.') ? timestamp : timestamp.replace('Z', '.000Z')) ||
    typeof event.instanceId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(event.instanceId) ||
    typeof event.operation !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(event.operation) ||
    !['accepted', 'completed', 'failed', 'timed_out'].includes(event.outcome) ||
    !(event.error === null || (typeof event.error === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(event.error)))) {
    throw new Error('Invalid audit record');
  }
  return event;
}

async function appendSeparator(file) {
  let position = (await file.stat()).size;
  if (!position) return '';
  const ending = Buffer.alloc(Math.min(position, 2));
  const { bytesRead } = await file.read(ending, 0, ending.length, position - ending.length);
  if (bytesRead !== ending.length) throw new Error('Audit changed during append');
  const terminated = [10, 13].includes(ending.at(-1));
  if (terminated) position -= ending.length === 2 && ending[0] === 13 && ending[1] === 10 ? 2 : 1;
  const chunks = [];
  while (position > 0) {
    const length = Math.min(position, 4096), chunk = Buffer.alloc(length);
    position -= length;
    const { bytesRead } = await file.read(chunk, 0, length, position);
    if (bytesRead !== length) throw new Error('Audit changed during append');
    const boundary = Math.max(chunk.lastIndexOf(10), chunk.lastIndexOf(13));
    chunks.unshift(chunk.subarray(boundary + 1));
    if (boundary !== -1) break;
  }
  const record = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  // Preserve the writer's legacy ability to append after delimited operator
  // metadata. It is opaque history, never trusted intent: replay stays strict.
  const metadata = terminated && record && typeof record === 'object' && !Array.isArray(record) &&
    Object.keys(record).length > 0 && !['timestamp', 'instanceId', 'operation', 'outcome', 'error'].some(key => Object.hasOwn(record, key));
  // Unterminated records need an audit schema before introducing a separator;
  // audit-shaped damage must fail closed even when already line-delimited.
  if (!metadata) validateRecord(record);
  return terminated ? '' : '\n';
}

// Append-only daily files. A clock rollback appends to the highest existing day,
// preserving durable acceptance order without changing historical record fields.
// Retention deletion is an operator responsibility. One controller owns the log.
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
          const event = validateRecord(JSON.parse(line));
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
      const day = `${safe.timestamp.slice(0, 10)}.jsonl`;
      const latest = (await readdir(this.directory)).filter(file => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().at(-1);
      const file = await open(join(this.directory, latest > day ? latest : day), 'a+', 0o600);
      try { await file.appendFile(`${await appendSeparator(file)}${JSON.stringify(safe)}\n`); }
      finally { await file.close(); }
    });
    this.tail = write.catch(() => {});
    return write;
  }
}
