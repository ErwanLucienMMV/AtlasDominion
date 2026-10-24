import { createPublicKey, verify } from 'node:crypto';
import { context, allowed } from '../docker-controller/security.mjs';

export { allowed };
export function publicKey(hex) {
  if (typeof hex !== 'string' || !/^[a-f0-9]{64}$/i.test(hex)) throw new Error('Invalid Discord public key');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' });
}
export function signed(key, body, headers, now = Date.now()) {
  const signature = headers['x-signature-ed25519'], timestamp = headers['x-signature-timestamp'];
  if (typeof signature !== 'string' || !/^[a-f0-9]{128}$/i.test(signature) || typeof timestamp !== 'string' ||
    !/^[0-9]{10,11}$/.test(timestamp) || Math.abs(now - Number(timestamp) * 1000) > 300000) return false;
  return verify(null, Buffer.concat([Buffer.from(timestamp), body]), key, Buffer.from(signature, 'hex'));
}
export function actor(interaction) {
  // DM identity and slash-command parameters never provide authorization.
  return context({ guildId: interaction.guild_id, userId: interaction.member?.user?.id, roleIds: interaction.member?.roles });
}
export function validateConfig(config) {
  publicKey(config.publicKey);
  if (!/^[0-9]{17,20}$/.test(config.applicationId) || typeof config.applicationId !== 'string' || !config.policy ||
    ['allowedDiscordGuilds', 'allowedDiscordUsers', 'allowedDiscordRoles'].some(k => !Array.isArray(config.policy[k]) || config.policy[k].some(v => typeof v !== 'string' || !/^[0-9]{17,20}$/.test(v))) ||
    !config.policy.allowedDiscordGuilds.length || !(config.policy.allowedDiscordUsers.length || config.policy.allowedDiscordRoles.length)) throw new Error('Invalid Discord policy');
  return config;
}

/** Bounded, ephemeral per-user rate limits; no identifiers are logged or persisted. */
export class RateLimit {
  constructor({ now = Date.now, maximum = 10000, limit = 20, windowMs = 60000 } = {}) {
    this.now = now; this.maximum = maximum; this.limit = limit; this.windowMs = windowMs; this.entries = new Map();
  }
  take(actor) {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.until <= now) this.entries.delete(key);
    const key = `${actor.guildId}:${actor.userId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maximum) return false;
      entry = { until: now + this.windowMs, count: 0 }; this.entries.set(key, entry);
    }
    return ++entry.count <= this.limit;
  }
}
