import { readFile } from 'node:fs/promises';
import Docker from 'dockerode';
import { loadRegistry } from './registry.mjs';
import { DockerAccess } from './docker.mjs';
import { ControllerService } from './service.mjs';
import { AuditLog } from './audit.mjs';
import { createApplication } from './http.mjs';

try {
  const config = JSON.parse(await readFile(process.env.CONTROLLER_CONFIG_FILE, 'utf8'));
  const secret = (await readFile(process.env.CONTROLLER_SECRET_FILE, 'utf8')).trim();
  if (!Array.isArray(config.bindingAddresses) || !config.bindingAddresses.length || !config.auditDirectory || !config.policy ||
    ['allowedDiscordGuilds', 'allowedDiscordUsers', 'allowedDiscordRoles'].some(k => !Array.isArray(config.policy[k]) || config.policy[k].some(v => typeof v !== 'string' || !/^[0-9]{17,20}$/.test(v))) ||
    !config.policy.allowedDiscordGuilds.length || !(config.policy.allowedDiscordUsers.length || config.policy.allowedDiscordRoles.length)) throw new Error('Invalid configuration');
  const docker = new DockerAccess(new Docker({ socketPath: '/var/run/docker.sock', timeout: config.timeoutMs }), config.bindingAddresses);
  const service = new ControllerService({ ...config, instances: await loadRegistry(process.env.REGISTRY_DIRECTORY), docker, audit: new AuditLog(config.auditDirectory) });
  try { await service.reconcile(); } catch { /* Authenticated health can retry after daemon recovery. */ }
  const app = await createApplication(service, [secret]);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
} catch {
  console.error('Controller startup failed: review protected configuration and dependencies.');
  process.exitCode = 1;
}
