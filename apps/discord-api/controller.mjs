import { createHash } from 'node:crypto';

const codes = new Set(['UNKNOWN_INSTANCE', 'FORBIDDEN', 'MISSING_CONTAINER', 'IDENTITY_MISMATCH', 'PORT_MISMATCH', 'OPERATION_CONFLICT', 'RESOURCE_EXHAUSTED', 'DOCKER_UNAVAILABLE', 'TIMEOUT', 'ADAPTER_UNAVAILABLE']);
export class ControllerError extends Error {
  constructor(code = 'DOCKER_UNAVAILABLE') { super(code); this.code = code; }
}
export class ControllerClient {
  constructor({ url, secret, timeoutMs = 5000, fetchImpl = fetch }) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new Error('Invalid controller configuration');
    this.url = parsed.origin; this.secret = secret; this.timeoutMs = timeoutMs; this.fetch = fetchImpl;
  }
  async request(path, authorization, body, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetch(`${this.url}${path}`, { method: body ? 'POST' : 'GET', redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { authorization: `Bearer ${this.secret}`, ...(body ? { 'content-type': 'application/json' } :
          { 'x-atlas-authorization-context': Buffer.from(JSON.stringify(authorization)).toString('base64url') }) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      // Bound private upstream responses as well as their transport time.
      let size = 0, chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length; if (size > 262144) throw new ControllerError(); chunks.push(chunk);
      }
      const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) throw new ControllerError(codes.has(data.code) ? data.code : undefined);
      return data;
    } catch (error) {
      if (error instanceof ControllerError) throw error;
      throw new ControllerError(timeout.aborted || signal?.aborted ? 'TIMEOUT' : 'DOCKER_UNAVAILABLE');
    }
  }
  list(actor, cursor, signal) {
    return this.request(`/v1/servers?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, actor, undefined, signal);
  }
  status(id, actor) { return this.request(`/v1/servers/${id}`, actor); }
  operate(id, action, actor, interactionId) {
    const idempotencyKey = createHash('sha256').update(`discord:${interactionId}:${action}:${id}`).digest('hex');
    return this.request(`/v1/servers/${id}/${action}`, actor, { authorization: actor, idempotencyKey });
  }
  operation(id, actor) { return this.request(`/v1/operations/${encodeURIComponent(id)}`, actor); }
}
