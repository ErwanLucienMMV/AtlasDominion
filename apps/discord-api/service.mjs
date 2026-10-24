import { setTimeout as delay } from 'node:timers/promises';
import { command, statusText, operationText, message, errorText } from './commands.mjs';

export class DiscordService {
  constructor({ controller, applicationId, fetchImpl = fetch, pollMs = 1000, completionMs = 120000, maxPending = 100 }) {
    this.controller = controller; this.applicationId = applicationId; this.fetch = fetchImpl;
    this.pollMs = pollMs; this.completionMs = completionMs; this.maxPending = maxPending; this.pending = new Set(); this.seen = new Map();
  }
  async autocomplete(selection, actor) {
    const signal = AbortSignal.timeout(1800), matches = [], seen = new Set();
    let cursor;
    // The entire search has a deadline, page cap, and bounded result count.
    for (let page = 0; page < 40; page++) {
      const result = await this.controller.list(actor, cursor, signal);
      for (const server of result.items) {
        if (`${server.displayName} ${server.instanceId}`.toLowerCase().includes(selection.instance.toLowerCase())) {
          matches.push({ name: `${server.displayName} (${server.instanceId})`.slice(0, 100), value: server.instanceId });
          if (matches.length === 25) return matches;
        }
      }
      if (!result.nextCursor || seen.has(result.nextCursor)) break;
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    return matches;
  }
  reserve(interaction) {
    const now = Date.now();
    for (const [id, until] of this.seen) if (until <= now) this.seen.delete(id);
    if (this.seen.has(interaction.id)) return 'duplicate';
    if (this.pending.size >= this.maxPending || this.seen.size >= 10000) return 'busy';
    this.seen.set(interaction.id, now + 15 * 60000); this.pending.add(interaction.id); return 'accepted';
  }
  async complete(interaction, selection, actor) {
    try {
      let content;
      if (selection.action === 'list') {
        const page = await this.controller.list(actor, selection.cursor, undefined, 3);
        content = page.items.length ? page.items.map(statusText).join('\n') : 'No accessible server instances.';
        content += page.nextCursor ? `\nNext page: /server list cursor:${page.nextCursor}` : '';
      } else if (selection.action === 'status') content = statusText(await this.controller.status(selection.instance, actor));
      else {
        let op = await this.controller.operate(selection.instance, selection.action, actor, interaction.id);
        const deadline = Date.now() + this.completionMs;
        while (!['completed', 'failed', 'timed_out'].includes(op.state) && Date.now() < deadline) {
          await delay(Math.min(this.pollMs, Math.max(0, deadline - Date.now())));
          if (Date.now() >= deadline) break;
          op = await this.controller.operation(op.operationId, actor);
        }
        content = operationText(op);
        if (!['completed', 'failed', 'timed_out'].includes(op.state)) content += ' Still pending; use /server status to check progress.';
      }
      await this.edit(interaction, content);
    } catch (error) {
      try { await this.edit(interaction, errorText(error)); } catch { /* No raw payload, token, URL or identity logging. */ }
    } finally { this.pending.delete(interaction.id); }
  }
  async edit(interaction, content) {
    const response = await this.fetch(`https://discord.com/api/v10/webhooks/${this.applicationId}/${interaction.token}/messages/@original`, {
      method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' }, body: JSON.stringify(message(content))
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Discord delivery failed'); }
    await response.body?.cancel();
  }
}
export { command };
