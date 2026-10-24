import { createHash, timingSafeEqual } from 'node:crypto';

const statuses = { INVALID_REQUEST: 400, UNAUTHENTICATED: 401, FORBIDDEN: 403, UNKNOWN_INSTANCE: 404, MISSING_CONTAINER: 409, IDENTITY_MISMATCH: 409, PORT_MISMATCH: 409, OPERATION_CONFLICT: 409, RESOURCE_EXHAUSTED: 429, DOCKER_UNAVAILABLE: 503, TIMEOUT: 504 };
export class Fault extends Error {
  constructor(code) { super(code); this.code = code; this.status = statuses[code] ?? 503; }
}
export function authenticate(header, secrets) {
  const value = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const hash = text => createHash('sha256').update(text).digest();
  let valid = false;
  for (const secret of secrets) valid = timingSafeEqual(hash(value), hash(secret)) || valid;
  if (!valid) throw new Fault('UNAUTHENTICATED');
}
export function context(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== 'guildId,roleIds,userId' ||
    !/^[0-9]{17,20}$/.test(value.guildId) || typeof value.guildId !== 'string' ||
    !/^[0-9]{17,20}$/.test(value.userId) || typeof value.userId !== 'string' ||
    !Array.isArray(value.roleIds) || value.roleIds.length > 100 || value.roleIds.some(id => typeof id !== 'string' || !/^[0-9]{17,20}$/.test(id))) throw new Fault('INVALID_REQUEST');
  return value;
}
export function allowed(policy, actor) {
  return policy.allowedDiscordGuilds.includes(actor.guildId) &&
    (policy.allowedDiscordUsers.includes(actor.userId) || actor.roleIds.some(id => policy.allowedDiscordRoles.includes(id)));
}
