# Phase 0 architecture and configuration contracts

Status: contract baseline, not production deployment approval. The six original root documents remain unchanged and locally ignored as originally configured.

## Sources of truth

`libs/server-registry/instance.schema.json` is the normative version-1 manifest schema. One JSON object per administrator-maintained file; validate the complete candidate registry together before activating it. JSON is the V1 format; the root YAML example is illustrative rather than executable configuration. `validateRegistry` adds cross-entry and identity-label constraints. Never activate a partially valid registry. Use a read-only allowlisted directory; reject symlinks or files escaping that directory in the future loader. V1 reload is a reviewed controller restart.

The fixture is test data with invented resource budgets and empty authorization lists. It is not an enabled server. An empty registry is valid and grants no control. Game types are informational identifiers, never a fixed game enum. Adding an adapter capability requires reviewed code and a schema revision; merely adding a generic-compatible game does not.

## Identity and permissions

Required labels are `io.atlasdominion.managed="true"` and `io.atlasdominion.instance="<stable-id>"`. They replace the illustrative `com.example` namespace for new configurations only. Container name and stable ID are separate. Before every operation resolve the name from the registry, pin the inspected Docker ID for the operation, and check exact labels, all published ports/protocols, approved binding addresses and restart policy. Labels alone never confer trust. Never silently adopt a replacement container during an operation. Missing container is distinct from unknown instance and Docker outage.

Published host ports are exclusive per protocol across this single-host registry, conservatively across all binding addresses. TCP and UDP may share a number. Compare against non-registry host listeners during onboarding too. Docker Compose owns effective image digests, volume mounts, binding addresses and resource limits; registry values are expectations, not provisioning instructions.

Authentication and authorization are separate. The API and controller both require an allowed guild AND an allowed user OR role within that guild's request context. Parentheses: `guildAllowed && (userAllowed || roleAllowed)`. Empty lists deny access. Global allowlists and instance policy intersect; neither widens the other. Both start and stop use this same permission. Discord identity comes only from a verified signed interaction; never from slash-command parameters. The private controller trusts identity claims only from the authenticated Discord service.

## Internal HTTP contract

All routes are private and require `Authorization: Bearer <service-secret>`, including health and metrics (separate least-privilege scrape credentials for metrics). Use at least 32 random secret bytes, injected via protected secret mounts. Compare secrets in constant time. Do not log headers or request bodies. Private network membership alone is not authentication. V1 uses the isolated same-host control network; authenticated TLS is required before crossing hosts or untrusted networks.

| Method/path | Success | Semantics |
|---|---|---|
| GET /v1/servers?limit=25&cursor=… | 200 Page<ServerStatus> | Stable ID ordering, limit 1–100, opaque bounded cursor; filter by authenticated authorization context |
| GET /v1/servers/:instanceId | 200 ServerStatus | Missing container remains visible as `missing` |
| POST /v1/servers/:instanceId/start | 202 Operation or 200 Operation | New work accepted asynchronously; already running is completed/idempotent |
| POST /v1/servers/:instanceId/stop | 202 Operation or 200 Operation | Already stopped is completed/idempotent |
| GET /v1/operations/:operationId | 200 Operation | Same instance authorization required |
| GET /v1/servers/:instanceId/events | 200 Page<AuditEvent> | Sanitized operational history |
| GET /v1/servers/:instanceId/metrics | 200 | JSON snapshot of the authorized instance's bounded metrics |
| GET /v1/health | 200 or 503 | Ready only after reconciliation; no configuration/secrets in body |
| GET /metrics | 200 | Prometheus text, private monitoring credential |

Types are in `libs/contracts/index.d.ts`. Timestamps use UTC RFC3339. User-scoped GET requests carry ephemeral AuthorizationContext JSON encoded as base64url in `X-Atlas-Authorization-Context` (maximum 8 KiB encoded); never a URL/query string. Reject unknown context fields, non-snowflake IDs and more than 100 role IDs. This header is trusted only after service authentication and must be stripped at public ingress. Health and service-wide metrics do not accept user context and require their own service permission. POST bodies contain only OperationRequest. Reject unknown fields, invalid IDs, malformed JSON, excessive bodies (16 KiB maximum), and unsupported verbs. Never accept container names, images, paths or commands. Every instance route reauthorizes; no unfiltered event/metric enumeration. Cursors and operation IDs grant no access by themselves.

Error body is ApiError with a fixed sanitized message: 400 INVALID_REQUEST, 401 UNAUTHENTICATED, 403 FORBIDDEN, 404 UNKNOWN_INSTANCE (also hide unauthorized instance existence), 409 IDENTITY_MISMATCH/PORT_MISMATCH/OPERATION_CONFLICT/MISSING_CONTAINER, 422 ADAPTER_UNAVAILABLE, 429 RESOURCE_EXHAUSTED, 503 DOCKER_UNAVAILABLE, 504 TIMEOUT. Operations accepted with 202 report eventual failure in Operation; acceptance never means readiness. Unauthorized callers are checked before lookup.

Idempotency keys are random opaque values, maximum 128 characters, scoped to authenticated service, instance and action, retained at least 15 minutes. Replays return the same operation; conflicting reuse returns 409. Per-instance locks serialize lifecycle work; atomic host resource reservations protect concurrent starts. No resource admission auto-stops another instance. Timed-out work must reconcile actual Docker state before retry/releasing reservations; timeout does not prove cancellation. Default operation timeout and headroom require measured operator configuration before deployment.

## Adapter boundaries

`libs/game-adapters/interfaces/index.d.ts` exposes only an approved container capability, cancellation and bounded stop timeout. Registry checks, authorization, locks, reservations, audit and metrics belong to the controller, not adapters. Generic lifecycle delegates start/stop to the approved container. `unverified` readiness never returns ready; `docker-health` returns unknown when no healthcheck exists and does not claim protocol-level game readiness. Missing optional capability must not turn into silent success.

Backup is a separate worker capability. `stopped-volume` requires the lifecycle lock coordinated with controller starts, confirmed stopped state for the full copy, and configured source/destination references. No host paths in the registry/API. Worker configuration separately maps these references to approved volumes, retention and schedule. Adapter interfaces describe future implementations, not working backups.

## Trust boundaries and networks

| Service | Networks | Privilege/exposure |
|---|---|---|
| Traefik | proxy | Public HTTPS; File Provider; no Docker socket |
| Discord API | proxy, control, dedicated outbound access as needed | Signed ingress; Discord webhook egress; no Docker socket |
| Controller | control, monitoring | Authenticated private API; Docker socket is host-level privilege |
| Prometheus/exporters | monitoring | Private metrics only; exporter privilege reviewed separately |
| Grafana | proxy, monitoring | Authenticated HTTPS; anonymous access disabled |
| Backup worker | private backup/control path as required | Scoped volume access; no public listener |
| Games | isolated per-game networks | Explicit native TCP/UDP mappings; no control/socket access |

Control and monitoring networks should be internal; explicit egress paths are needed for services that require outbound connections. Network attachment is not route-level access control: protect the controller API even on monitoring. Game traffic bypasses HTTP routers. Preserve the existing port 4242 workload. No Compose deployment, firewall change or host inspection has been performed by Phase 0.

## Responsibilities and security decisions

Operator owns pinned-image Compose provisioning, labels, resource constraints, ports, host firewall, secrets, registration approval and update/restore authorization. Controller owns lifecycle policy only. Backup worker owns schedules, archive integrity, bounded retention and isolated restoration tests; deletion of prior backups requires the approved retention policy and a verified usable replacement. Monitoring and backup scheduling remain independent of game uptime.

Security.md's prohibition on personal identifiers takes precedence over PLAN.md's suggested audit field “who requested”. Persist AuditEvent only; authorization context is ephemeral. Never store Discord IDs, interaction tokens, raw payloads, request headers or client IPs in application audit. Traefik access logs default to disabled pending a reviewed redaction policy. Proposed production choices: native Grafana accounts with anonymous/default credentials disabled, service bearer authentication, seven-day application event retention. These choices require operator confirmation before deployment; backup retention remains unset until measured capacity and restore requirements are known.

Secret rotation: create a new independent secret, temporarily accept old/new values, update callers, verify health, revoke old value, confirm old credential rejection. Never put secret values in Git, command arguments or logs. Compromise requires immediate revocation and incident review. Production configuration must fail closed when secret, guild policy or required capacity settings are missing.

## Remaining deployment gates

Hostname/ACME strategy; port 80/443 occupancy; RAM/CPU/disk headroom; RAID level/health; Discord allowlists; backup location/schedule/retention; confirmed log retention and authentication choices. Run the read-only inventory in OPERATIONS.md on the actual Linux host and record evidence privately. No SSH access or measurement evidence was supplied, so none is fabricated here. Phase 1 must wait for relevant gate resolution and explicit deployment approval.
