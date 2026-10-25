# Phase 5 validation

Implementation is complete locally. No monitoring service, game, image, DNS entry, firewall rule or volume was deployed or modified. Production acceptance remains pending under the [Phase 5 runbook](PHASE_5_MONITORING.md).

## Delivered and security review

- Authenticated Prometheus exposition, generic stable instance labels, state/intent, unexpected-exit counters, terminal operation outcomes/duration, operation age, controller/audit health and admission reservations.
- Read-only container CPU/memory sampling through the existing identity-verified controller boundary; no additional Docker-privileged exporter.
- Docker event streaming with bounded frame handling, reconnect, periodic inspection, shutdown cleanup and reservation recovery. Persistent desired state is replayed from sanitized audit history without rewriting records or restarting games.
- Independent private Prometheus, Grafana and host Node Exporter configuration, bounded metrics retention, persistent external volumes, dashboard/datasource provisioning and explicit HTTPS route example. No monitoring host ports are published. Anonymous access and sign-up are disabled.
- Separate metrics-only credential in the deployment override. Tests verify it cannot access lifecycle APIs, and the lifecycle credential cannot scrape when separation is configured. Legacy configurations retain compatibility until the override is adopted.
- Rules distinguish deliberate stops, unexpected exits, controller failure, stale state, admission-budget pressure and measured host saturation. No alert notification receiver is silently configured.

The broad read-only host root mount and PID visibility required by Node Exporter need deployment review. Metrics credentials, datasource access, volume ownership, host overhead and retention decisions are operator gates. Grafana viewers can query all datasource metrics. The runbook explains stale samples, counter resets, replay limits, corrupt-audit startup failure and audit retention implications. No Minecraft-specific monitoring code was added. Existing tests, services and lifecycle rejection behavior remain intact.

## Executed checks

Environment: Windows, Node 20.15.1 and Docker Compose v2.35.1-desktop.1. Compose checks use `config` only and require no Engine operations.

- Intermediate complete `npm test`: **510 passed**, no failures/skips/cancellations, after the first milestone. After scoped authentication and stack tests: **514 passed**, no failures/skips/cancellations.
- Latest complete `npm test`: **517 passed**, no failures/skips/cancellations, including all pre-existing untracked tests and thirteen Phase 5 tests. Log: `%TEMP%/atlas-phase5-complete-tests.log`. The final counter-deduplication adjustment was additionally covered by the focused runtime run below.
- Final focused runtime and Compose checks: **20 passed**, no failures/skips/cancellations. Command: `node --test tests/phase5-monitoring.test.mjs infrastructure/checks/monitoring.check.mjs infrastructure/checks/compose.check.mjs`. Includes all eight existing Compose checks and both new monitoring Compose checks. Log: `%TEMP%/atlas-phase5-focused-final.log`.
- Static monitoring configuration tests: **3 passed** as part of the focused stack run and complete npm suite. They verify private networks, external persistence, secret references, dashboard discovery and controller mount preservation.
- `git diff --check` and Node syntax checks for the event/metrics module and controller entrypoint passed. Git emits normal LF-to-CRLF normalization notices.

The initial sandboxed npm run could not start Node due to Windows parent-directory `EPERM`. Tests subsequently ran with required process permission. A direct `node --test` run passed 461 checks but failed 49 existing Phase 0 documentation checks because those checks explicitly require npm's CLI environment; rerunning unchanged through `npm test` passed. The initial new mock used object-reference lookup despite validated registry cloning; stable-ID lookup corrected that fixture, after which all focused tests passed. No existing assertions or verification settings were weakened.

`promtool` and a standalone YAML parser are not installed. Prometheus config/rule semantic validation, Grafana provisioning/rendering, real Docker stats/event compatibility, host exporter coverage, actual Discord stop behavior, notification delivery and HTTPS/network isolation require the selected binaries and approved Linux host. Commands and live gates are in the runbook; no local mock or Compose parse result is claimed as proof of those checks.

## Preservation and next phase

The fourteen pre-existing untracked test/report files were preserved and excluded from milestone commits. They remain included in full npm validation. No dependencies, lockfiles, existing test files or CI enforcement were changed. Commits are forward-only and local, with a timestamp guard requiring at least 120 elapsed seconds between milestones. No push, merge or history rewrite occurred.

Next implementation phase: Phase 6 modular backup worker. Backup/TLS/Discord synthetic monitoring integrations and an approved alert notification receiver remain explicit follow-up work rather than placeholder success signals.
