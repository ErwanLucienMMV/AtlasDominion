import { readFile } from 'node:fs/promises';
import { ControllerClient } from './controller.mjs';
import { DiscordService } from './service.mjs';
import { createDiscordApplication } from './http.mjs';

try {
  const config = JSON.parse(await readFile(process.env.DISCORD_CONFIG_FILE, 'utf8'));
  const secret = (await readFile(process.env.CONTROLLER_SECRET_FILE, 'utf8')).trim();
  const controller = new ControllerClient({ url: process.env.CONTROLLER_URL, secret });
  const app = await createDiscordApplication(new DiscordService({ controller, applicationId: config.applicationId }), config);
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
} catch {
  console.error('Discord API startup failed: review protected configuration and dependencies.');
  process.exitCode = 1;
}
