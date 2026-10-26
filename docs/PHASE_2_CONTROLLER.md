# Phase 2: generic Docker controller

The NestJS application in `apps/docker-controller` uses Dockerode exclusively to inspect, start and stop administrator-created containers. No provisioning, exec, pull, update, removal or public registry mutation is exposed. The existing infrastructure is not deployed or modified by this phase.

## Local verification

Use Node 20 or newer, `npm ci`, then `npm test`. Start with `npm run start:controller` only after supplying protected configuration. Tests use mock Docker interfaces; they do not contact the host Docker Engine. HTTP tests run the real NestJS server on a loopback ephemeral port.

## Required protected configuration

Set `REGISTRY_DIRECTORY` to an administrator-owned read-only directory containing one instance JSON manifest per file. Symlinks and oversized manifests are rejected; the entire registry is validated before activation. Reload requires a reviewed restart. Set `CONTROLLER_SECRET_FILE` to a protected file containing at least 32 random bytes encoded as a bearer token (for example 64 hexadecimal characters). Set `CONTROLLER_CONFIG_FILE` to a protected JSON file with this shape:

```json
{
  "policy": {
    "allowedDiscordGuilds": ["REPLACE_WITH_APPROVED_SNOWFLAKE"],
    "allowedDiscordUsers": ["REPLACE_WITH_APPROVED_SNOWFLAKE"],
    "allowedDiscordRoles": []
  },
  "bindingAddresses": ["REPLACE_WITH_APPROVED_DOCKER_BIND_ADDRESS"],
  "capacity": { "memoryMiB": 0, "cpuUnits": 0 },
  "timeoutMs": 120000,
  "stopTimeoutSeconds": 60,
  "auditDirectory": "/audit"
}
```

This deliberately invalid example cannot start. Replace capacity with measured game budgets **after** reserving resources for OS, the existing TCP 4242 application, monitoring and backup overhead. Binding addresses must exactly match Docker's configured `HostIp`, including an empty string if that is explicitly approved. Port bindings and protocols must match the manifest exactly, restart policy must be `no`, host networking, privilege and automatic port publishing are rejected. Optional hard memory constraints must match Docker inspection.

Game inspection also requires an explicit nonroot `Config.User`, a positive safe-integer `PidsLimit`, and either positive safe-integer `NanoCpus` or positive safe-integer `CpuQuota` and `CpuPeriod`. These are finite-ceiling checks; operators still approve measured CPU/PID sizing. Network attachments must exactly match `container.allowedNetworks`, or the default single network `atlas-game-<stable-id>` when that optional manifest field is absent. `HostConfig.NetworkMode` must name an approved network. Management, host and default/shared bridge approvals are forbidden. Correct provisioning drift through a separately reviewed operator plan; the controller rejects it and never updates a container automatically. Existing manifests need no new field when they use the shipped network convention. Reviewed alternative network names belong in the protected registry, independently of client input. See [identity corrective evidence](PHASE_9_IDENTITY_FIX.md).

Mount `/audit` as a dedicated writable persistent directory; preserve all existing data. Add the configuration file as a read-only mount and its environment variable to an operator-reviewed Compose override. The Phase 1 Compose template alone intentionally lacks these deployment-specific values. Do not publish controller ports or attach it to the proxy network. Docker socket access remains host-level privilege even with a read-only mount. Only one controller process/replica may own a registry: locks and reservations are in memory and are not distributed.

## API and lifecycle

Implemented private routes: `GET /v1/health`, `GET /v1/servers`, `GET /v1/servers/:instanceId`, `POST /v1/servers/:instanceId/start`, `POST /v1/servers/:instanceId/stop`, `GET /v1/operations/:operationId`. All require bearer authentication, including health. User GET routes additionally require base64url JSON `X-Atlas-Authorization-Context`; POST bodies contain only `authorization` and a random 16–128 character `idempotencyKey` using letters, digits, underscore or hyphen. Global and instance policies intersect. Unknown and unauthorized instances share the same response. Pagination uses stable instance ordering and bounded opaque cursors with limits 1–100.

Start/stop return 202 for accepted asynchronous work and 200 for completed idempotent work or terminal replays. Poll the operation endpoint for actual completion; Docker running does not establish game readiness. `unverified` stays unverified; `docker-health` without a healthcheck returns unknown. A missing container is visible in status and cannot be started or silently recreated.

Operation keys and results remain in memory for at least 15 minutes and are bounded to 10,000 entries; saturation rejects additional work. Reusing a key for the opposite action conflicts. Keys are scoped to the sole authenticated service and instance. Replays are reauthorized. Restart clears operation keys/results, so callers must inspect state after controller restart. Container IDs are pinned from preflight through completion. Per-instance locks prevent conflicting work; a process-wide admission queue makes resource reservations atomic. Startup reconciliation reserves already-running containers. Every new start reconciles external Docker state before admission. Timeouts retain locks and reservations until underlying work settles, then reconcile; they never imply cancellation.

Audit records append to UTC daily JSONL files with restricted permissions and only timestamp, instance ID, action, outcome and sanitized error. No Discord identifiers, tokens, raw requests or container internals are recorded. Audit failure blocks admission or marks work failed and readiness false; it is not silently reported as success. Define and approve retention before deployment; this phase never deletes audit data. Review OS permissions on the real Linux host.

The Phase 9 correction keeps audit filenames monotonically nondecreasing: after wall-clock rollback, new records append to the highest existing daily filename while retaining their actual event timestamps. This preserves filename/append replay order without new fields or rewritten history. One active controller owns the audit directory. Older histories already written out of acceptance order need operator investigation; timestamps alone cannot reconstruct missing acceptance order. See [corrective validation](PHASE_9_FIX_VALIDATION.md).

Controller `timeoutMs` must not exceed Node's timer maximum of 2,147,483,647 milliseconds. Elapsed-time budgets use the monotonic performance clock. Asynchronous execution includes terminal audit writes in its deadline; expiry reports `timed_out` while holding ownership until outstanding Engine and persistence work settle. A late completion write is followed by the terminal timeout correction before readiness can recover.

Failed audit records independently block readiness: successful Docker inspection cannot clear that block. Reconciliation retries the pending sanitized records and restores readiness only after they persist. Terminal success is published only after its audit write succeeds; failed no-op completion is retained as a sanitized failed operation for same-key replay. Pending audit recovery records are in memory and require process continuity; persistent recovery across controller restarts remains outside this implementation.

Preflight has a controller deadline of `timeoutMs` shared across inspection, admission reconciliation and audit writes, including no-op completion audit. Expiry returns `TIMEOUT` and releases the shared admission queue. The instance lock and any reservation remain until the outstanding dependency settles; the expired preflight cannot continue into Docker mutation. Subsequent new work fails closed until reconciliation succeeds. This deadline is separate from the asynchronous Docker mutation deadline and Dockerode's transport timeout; it does not cancel either Docker or filesystem work. Live transport behavior requires separate validation.

## Security review and remaining phases

Authentication uses fixed-size hash comparison, validates credentials before body parsing, limits JSON bodies to 16 KiB and suppresses framework request/error logging. Use same-host isolated control networking; authenticated TLS is required before crossing hosts. Never trust the identity header from public ingress. The API has no arbitrary Docker capability. Registry validation and runtime identity checks apply independently of client input.

Dependencies are pinned with a lockfile. The `multer` override selects patched 2.5.0 because the NestJS platform adapter currently pins an older vulnerable upload parser; this application does not expose upload routes. Review the override when upgrading NestJS.

Health retries reconciliation after Docker recovery. Continuous event reconciliation, Prometheus metrics, event-history endpoints, bounded metrics snapshots and audit retention automation belong to Phase 5. Discord signatures, ingress authorization and deferred replies belong to Phase 3. No monitoring endpoints falsely claim to exist. Live Dockerode/Engine integration, graceful game stop, port reachability, persistence and resource measurements remain operator-gated checks for Phase 4. No host deployment, production restart, firewall change or real game lifecycle operation is authorized by these files.

Implementation references: [NestJS controllers](https://docs.nestjs.com/controllers), [Dockerode API](https://github.com/apocas/dockerode).
