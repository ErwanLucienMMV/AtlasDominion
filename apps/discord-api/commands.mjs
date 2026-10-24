const instance = { type: 3, name: 'instance', description: 'Registered server instance', required: true, autocomplete: true };
export const serverCommand = {
  name: 'server', description: 'Manage approved server instances', type: 1, contexts: [0], integration_types: [0],
  options: [
    { type: 1, name: 'list', description: 'List accessible servers', options: [{ type: 3, name: 'cursor', description: 'Next-page cursor from the previous list', required: false }] },
    ...['status', 'start', 'stop'].map(name => ({ type: 1, name, description: `${name} a registered server`, options: [{ ...instance }] }))
  ]
};

export function command(data, autocomplete = false) {
  if (data?.name !== 'server' || (data.type !== undefined && data.type !== 1) || !Array.isArray(data.options) || data.options.length !== 1) throw new Error('Invalid command');
  const sub = data.options[0];
  if (sub.type !== 1 || !['list', 'status', 'start', 'stop'].includes(sub.name)) throw new Error('Invalid command');
  const options = sub.options ?? [];
  if (!Array.isArray(options) || options.length > 1) throw new Error('Invalid options');
  if (sub.name === 'list') {
    if (autocomplete || (options.length && (options[0].name !== 'cursor' || options[0].type !== 3 || typeof options[0].value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(options[0].value)))) throw new Error('Invalid cursor');
    return { action: 'list', cursor: options[0]?.value };
  }
  const option = options[0];
  if (!option || option.name !== 'instance' || option.type !== 3 || typeof option.value !== 'string' ||
    (autocomplete ? option.focused !== true || option.value.length > 100 : !/^[a-z0-9][a-z0-9-]{0,62}$/.test(option.value))) throw new Error('Invalid instance');
  return { action: sub.name, instance: option.value };
}

const clean = value => String(value).replace(/[`*~|\\<>@\r\n]/g, ' ').slice(0, 100);
export function statusText(server) {
  return `${clean(server.displayName)} (${clean(server.instanceId)}): Docker ${clean(server.docker)}; readiness ${clean(server.readiness)}; desired ${clean(server.desired)}.`;
}
export function operationText(op) {
  return `Instance ${clean(op.instanceId)}: ${clean(op.action)} ${clean(op.state)}${op.result ? ` (${clean(op.result)})` : ''}${op.error ? ` (${clean(op.error)})` : ''}. Operation ${clean(op.operationId)}. Container lifecycle does not establish game readiness.`;
}
export function message(content) { return { content: content.slice(0, 2000), allowed_mentions: { parse: [] } }; }
export function errorText(error) {
  const messages = {
    UNKNOWN_INSTANCE: 'Unknown or inaccessible server instance.', FORBIDDEN: 'You are not authorized for this operation.',
    MISSING_CONTAINER: 'The registered container is missing. Ask an administrator to provision it.',
    OPERATION_CONFLICT: 'Another operation is in progress. Check status before retrying.',
    RESOURCE_EXHAUSTED: 'Capacity or request limits reached. Try again later.',
    TIMEOUT: 'The controller request timed out. The operation may still be running; check status before retrying.',
    IDENTITY_MISMATCH: 'Container identity validation failed. Ask an administrator.', PORT_MISMATCH: 'Container port validation failed. Ask an administrator.'
  };
  return messages[error?.code] ?? 'The controller is unavailable or could not complete this request. Check status before retrying.';
}
