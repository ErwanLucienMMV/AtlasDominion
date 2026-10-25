# Disaster recovery and production acceptance

Use this with [backup procedures](PHASE_6_BACKUP.md), [onboarding/removal](ADDING_A_GAME.md) and [Phase 9 safeguards](PHASE_9_HARDENING.md). Commands below do not authorize host changes. Reboots, daemon restarts, production container changes, volume activation, lock removal and deletion require specific operator approval. Preserve the existing TCP 4242 workload.

## Incident evidence and diagnosis

Record UTC incident time, affected instance IDs, pinned image digests, registry/configuration revision, audit outcomes, last verified archive and current health. Keep secrets, raw Discord payloads and personal identifiers out of reports. Inspect host capacity, RAID state, Docker state and network membership before changing anything. Preserve damaged archives, partial restores, audit files and locks; do not run stack-wide teardown, prune, recreation or cleanup commands.

Use read-only host inventory (`docker ps`, `docker network inspect`, `docker inspect`, `free -h`, `df -hT`, `cat /proc/mdstat`, `ss -lntup`) through approved operator access. Do not print secret environment variables or unrestricted container inspections into public reports. Compare actual game port protocol/address/number to each manifest and Compose definition. Internal control, monitoring and proxy networks must be reviewed internal bridges, as specified in `infrastructure/networks/README.md`; external network declarations alone do not enforce this.

## Docker daemon outage

1. Confirm authenticated controller health reports unready or an unavailable response. An unreachable daemon is unknown state, not a successful stop. Inspect service/host health without issuing game operations.
2. Preserve locks and reservations. A timeout does not cancel a Docker request; do not repeat the request directly through Compose. Already running processes may survive depending on daemon/live-restore configuration; inspect rather than assume.
3. Obtain approval for any required daemon/service recovery, considering all existing workloads. After Engine recovery, verify container identity, restart policies, exact native port bindings, mounts and observed states.
4. Confirm authenticated health recovers, event streaming reconnects, reconciliation timestamps advance and resource sampling becomes healthy. Verify audit writes persist; Docker recovery cannot repair a full or unwritable audit filesystem.
5. Resolve any uncertain operation from audit and actual container state before a new authorized lifecycle request. Never provision a missing container automatically.

`tests/phase9-recovery.test.mjs` verifies simulated outage/recovery and absence of automatic restarts. Real daemon interruption remains a maintenance-window gate.

## Host reboot / application restart

Infrastructure templates use `unless-stopped`; game templates use `restart: 'no'`. Games should remain stopped after host reboot until explicitly started. Preserve the Docker data root, external world/audit/metrics volumes, protected configuration, registry, certificates and backup/lock directories. Back up protected configuration separately; secret recovery must use the operator's protected store.

Before an approved reboot, save/stop games gracefully, verify a recoverable backup, record the running-instance inventory and check the existing workload's recovery procedure. After reboot, first inspect storage/RAID health and network membership, then confirm infrastructure resumes or diagnose explicitly stopped services. Observe container state before any starts. The controller reconstructs desired state from audit and reserves observed running instances; it never starts a game merely to match old intent. Wanted-running games left stopped should alert; deliberate stops should stay quiet.

Persistent backup locks survive crashes and restarts. Investigate both owners and all underlying copy/Docker work before requesting approval to remove a specific orphan lock. Age alone is insufficient. The simulated cold-restart test reopens real temporary audit files and leaves backup exclusion intact. It cannot certify systemd, Docker storage, live-restore behavior, boot ordering or actual hardware recovery. Record these during an approved Linux reboot drill.

## Isolated backup restoration

Choose a trusted archive belonging to the exact stable instance ID. Preserve the active world and the archive. Check free disk space for a full restored copy plus reserve. Run this dependency-free offline command, using an absent destination under a trusted parent directory:

```sh
node scripts/verify-recovery.mjs minecraft-survival /approved/archives/minecraft-survival/ARCHIVE_ID /approved/new-recovery-drill
```

It verifies SHA-256 inventory before restoring and compares recovered bytes afterwards. Existing destinations are refused. The narrow CLI imports no Docker client, reads no service secrets and emits no archive paths or contents. Errors preserve any partial output for investigation; choose another fresh destination for a retry. It shares the worker's restore implementation; the existing `apps/backup-worker/main.mjs restore` command remains supported. Restored ownership/modes need operator review.

Byte restoration does not prove game consistency. With separate approval, provision an isolated test volume/container using the recorded image/world version; avoid production ports and live volumes. Verify known world/player state with a real client, save cleanly, stop, and repeat a persistence check. Record elapsed recovery time, snapshot age, file checksums and gameplay evidence against operator-selected RTO/RPO. Production activation requires a preserved current-world snapshot, an explicit copy/mount plan and rollback approval. This tool never activates restored data.

On-host archives cannot recover from complete disk/host loss. Off-host transfer is not implemented. Until a protected, verified external copy exists, total host loss can mean permanent world loss. Record that exposure before production acceptance; do not describe RAID as a backup.

## Authentication and ingress acceptance

Keep distinct protected controller and metrics tokens, at least 32 bytes each, and a unique Grafana password. Public Discord receives no Docker credentials beyond its narrowly used private controller credential. The controller independently validates policy, exact instance identity/labels, ports, isolation and resource reservations. Approved authorization context is trusted only after service authentication; possession of that credential is a privileged trust boundary.

Main processes load file secrets at startup. Rotate through an approved coordinated API/controller restart (and Prometheus reload/restart for metrics); replacing a file alone does not rotate in-memory credentials. No automatic hot rotation or main-process overlapping-token window is implemented. Verify old-token rejection, new-token success, metrics-token rejection on lifecycle endpoints and service-token rejection on metrics when credentials are separated. Never paste tokens into logs or command history.

Before exposure, execute signed/unsigned/tampered/replayed Discord request checks and verify no unauthorized lifecycle calls occur. Confirm only the explicit POST interaction route reaches the API, internal authorization headers are stripped, HTTPS is valid, and wrong paths/methods cannot reach management routes. From an external machine verify management/exporter/backup ports are inaccessible and each approved native TCP/UDP game port works as intended. Also verify game-network isolation and existing TCP 4242 service continuity. Docker publish rules can bypass ordinary host-firewall assumptions; use real external probes. No firewall change is performed by the repository.

## Logging, monitoring and retention

Audit retains only time, instance ID, operation, outcome and sanitized error. Application stdout/access logging remains minimized; inspect game/provider/OS logs separately for personal data. Audit directories/files request modes 0700/0600; verify actual Linux ownership and permissions. Traefik access logs are disabled or allowlist-sanitized. Prometheus has explicit time/size retention; infrastructure local logs have bounded rotation where enabled. Backup retention deletion is opt-in and requires a verified replacement; failures remain evidence.

Audit files remain append-only with no automatic pruning. Approve a storage budget and review daily growth/free space. Do not delete older audit files without preserving intent-recovery evidence; no audit checkpoint/compaction is implemented. A full disk blocks durable operation acceptance. Backup evidence and optional proxy access files also require an approved retention/archive policy; Docker stdout rotation does not rotate bind-mounted access files.

Run `npm test`, `npm run check:production`, `promtool check rules infrastructure/monitoring/alerts.yml` and `promtool test rules tests/fixtures/phase9/alerts.test.yml`. Verify generic instance discovery, controller readiness, reconciliation/event/sampling health, host CPU/RAM/disk pressure and intended-stop suppression. Test an alert receiver end to end: rule evaluation alone does not deliver a notification. Backup failure/liveness currently uses sanitized worker logs and needs an approved receiver. Discord reachability and TLS expiry need operator probes; no blackbox exporter or notification integration is claimed.

## Completion record

Record the deployment revision, host inventory, network and privilege review, auth/ingress/port results, capacity budget, retention policy, alert delivery, daemon/reboot drill and byte/gameplay restore results. Keep unresolved gates visible. No further real game integration or architecture change is included in Phase 9; the next work is operator-reviewed Linux deployment and acceptance, followed by a separately scoped off-host backup project.
