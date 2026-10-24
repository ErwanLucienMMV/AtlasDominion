import { serverCommand } from '../apps/discord-api/commands.mjs';

// Local artifact only: no token, Discord call, or remote command overwrite.
console.log(JSON.stringify(serverCommand, null, 2));
