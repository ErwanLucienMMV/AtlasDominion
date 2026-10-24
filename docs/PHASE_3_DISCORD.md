# Phase 3: generic Discord integration

The independent NestJS service in `apps/discord-api` receives HTTP interactions at `POST /discord/interactions`, matching the existing Traefik File Provider route. It uses no Gateway, Docker socket, local registry copy or game-specific handlers. The controller remains the authority for instance visibility and lifecycle authorization.

## Configuration and setup

Install the pinned dependencies with `npm ci`. Supply `DISCORD_CONFIG_FILE`, a protected read-only JSON file:

```json
{
  "applicationId": "REPLACE_WITH_APPLICATION_SNOWFLAKE",
  "publicKey": "REPLACE_WITH_64_HEX_CHAR_ED25519_PUBLIC_KEY",
  "policy": {
    "allowedDiscordGuilds": ["REPLACE_WITH_APPROVED_GUILD_SNOWFLAKE"],
    "allowedDiscordUsers": ["REPLACE_WITH_APPROVED_USER_SNOWFLAKE"],
    "allowedDiscordRoles": []
  }
}
```

The example deliberately fails validation. Empty guild or principal allowlists fail startup. Set `CONTROLLER_URL=http://atlas-controller:3000` on the isolated same-host control network and `CONTROLLER_SECRET_FILE` to the protected shared secret file described in Phase 2. Cross-host traffic requires authenticated TLS. Start with `npm run start:discord`; `PORT` defaults to 3000. No bot token is needed to handle interactions or edit their replies.

Use an operator-reviewed Compose override to mount the configuration read-only and set `DISCORD_CONFIG_FILE`. The Phase 1 application template already supplies the service secret, private controller URL, proxy/control networks and outbound network; it does not supply operator policy. Preserve its lack of Docker privileges and published controller ports. Keep ingress header redaction and request-body logging disabled, including at any external proxy.

Generate the game-independent command definition locally with `node scripts/discord-command.mjs`. Register that single command using the approved Discord application/guild administrator workflow, inspecting existing command registrations before updating anything. This script only prints JSON; it does not overwrite remote registrations. The command is guild-only with four subcommands:

- `/server list [cursor]`: three full status entries per page; the reply includes a next-page cursor when needed.
- `/server status instance`: current Docker, desired and readiness states.
- `/server start instance`: request lifecycle work, then follow its operation.
- `/server stop instance`: request lifecycle work, then follow its operation.

Set the Discord Developer Portal Interactions Endpoint URL to the approved public HTTPS `/discord/interactions` URL after deployment approval. Validate the signed PING handshake. Do not expose an unsigned diagnostic endpoint. Configure the public key for this exact application. No deployment or command registration is performed by this implementation.

## Selection, acknowledgements and errors

Instance options use autocomplete from controller-filtered registry pages. Search matches display name or stable ID, supports repeated game types and new game types without source changes, returns at most 25 choices, and scans at most 40 pages under a total 1.8-second controller deadline. A narrower search finds instances beyond the first 25. Failure returns an empty choice set, since autocomplete cannot defer. Typed IDs remain valid inputs but always undergo controller authorization.

Commands receive an immediate ephemeral deferred response before controller I/O. The service edits the original response using the interaction token; it suppresses mentions. Controller requests have five-second transport/body deadlines, reject redirects and cap responses at 256 KiB. Start and stop poll operation IDs once per second for up to two minutes, then report pending state and direct the user to status. Acceptance and Docker running never imply game readiness. Unknown and unauthorized instances share the same message; other expected controller errors have fixed sanitized messages.

## Security review

Node crypto verifies Ed25519 over timestamp plus exact raw request bytes before JSON parsing or identity extraction. Invalid or missing signatures return 401. Requests over 64 KiB, compressed payloads and malformed JSON fail closed. Timestamps outside a five-minute window are rejected; keep the host clock synchronized.

Only a verified guild member's user and role IDs form the ephemeral authorization context. DMs, wrong application IDs, malformed IDs, arbitrary command options, paths and provisioning commands are rejected. Discord policy requires allowed guild AND (allowed user OR role). Controller global and instance policy checks independently intersect this policy for every request, including every operation poll and autocomplete page. Client-supplied public authorization headers are never forwarded.

Per guild/user limits allow 20 interactions per minute with at most 10,000 ephemeral buckets. At most 100 deferred jobs and 10,000 fifteen-minute replay entries are retained. Retries of the same signed interaction do not create new jobs; a deterministic SHA-256 idempotency key also protects controller lifecycle requests. All responses are ephemeral. Raw payloads, tokens, headers, Discord identifiers and upstream exceptions are never logged or persisted by the application.

## Limits and next phase

Single-process in-memory rate limits and replay protection reset at restart and are not shared between replicas. Controller idempotency also resets at its restart: after a restart, inspect status before requesting another lifecycle action. Shutdown or process failure can lose deferred jobs. Discord webhook delivery has a five-second deadline but no durable retry queue; delivery failure cannot reverse an accepted operation. No raw failure detail is logged. These are operational limits, not evidence of successful delivery.

Autocomplete scans at most 1,000 accessible entries; this targets dozens of instances. List cursors are controller offsets and can shift after registry reload. No registry cache is maintained. Command registration, live Discord acknowledgement timing, TLS, webhook connectivity and real Docker behavior require operator validation; local tests do not establish those deployment properties.

Phase 4 is the first approved real Minecraft integration, including client connectivity and world persistence. Phase 5 adds monitoring and lifecycle events; Phase 6 adds backups. This phase adds none of those services.

Protocol references: [Discord interaction verification](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/overview.mdx) and [responses, autocomplete and webhook deadlines](https://github.com/discord/discord-api-docs/blob/main/developers/interactions/receiving-and-responding.mdx).
