# Phase 3 acceptance checks

Run `npm test` after installing pinned dependencies with `npm ci`. The tests never call Discord or the real Docker Engine.

| Requirement | Automated evidence |
|---|---|
| Valid/invalid signed requests | `discord-security.test.mjs`: exact-byte Ed25519 verification, timestamp freshness, malformed headers; `discord-http.test.mjs`: real signed HTTP PING and invalid-signature rejection |
| Authorized/unauthorized users | Security tests cover guild AND user-or-role logic, DMs and malformed roles; HTTP tests reject wrong guild, user and application before controller work |
| Dynamic selection | HTTP tests traverse multiple live registry pages and cap autocomplete at 25; controller integration tests enumerate 32 instances, including repeated and previously unknown game types |
| Instance permissions | Real private controller integration hides unauthorized entries and rejects unauthorized typed IDs with the same error as unknown IDs |
| List/status/start/stop | HTTP tests cover paginated status text and asynchronous operation completion; controller integration exercises start and stop through the real private Nest API with mock containers |
| Controller unavailable | HTTP tests deliver sanitized deferred errors; real stalled HTTP transport tests exercise request and autocomplete deadlines |
| Acknowledgement deadline | A real signed HTTP command returns an ephemeral defer within 2.5 seconds while its controller dependency remains blocked |
| Duplicate requests and limits | Tests cover stable controller idempotency keys, duplicate delivery, rate limiter expiry/saturation, bounded pending jobs and per-user limits |
| Error isolation | Redirect rejection, oversized upstream replies, mention suppression, pending/failed operations and failed webhook delivery have regressions |

Before production acceptance, an operator must separately record these live checks after deployment approval:

1. Real HTTPS signed PING succeeds at `/discord/interactions`; negative signature probes fail with 401.
2. Reviewed guild-only `/server` registration exposes all four subcommands and autocomplete.
3. Allowed user and role work in the allowed guild; unapproved user/guild, DMs and inaccessible instances cannot control or enumerate instances.
4. Lists paginate, narrower autocomplete searches find later instances, and stopped/missing/unverified states remain distinguishable.
5. Discord visibly acknowledges commands within three seconds while the controller is slow or unavailable; webhook egress delivers the private final reply.
6. Start/stop results reflect actual operation completion and preserve existing services. Real game connectivity and persistence belong to Phase 4.
7. Review proxy/application log samples for forbidden headers, raw payloads, identities, IPs and tokens; verify controller remains private and Discord API has no Docker socket.

These checks are not deployment permission. No live Discord, TLS, game or Docker result is inferred from mocked transport or loopback tests.
