# Phase 6 validation

## Delivered

Independent scheduled backup worker and fresh-directory recovery CLI; per-instance protected configuration; shared persistent lifecycle locks; generic stopped-volume copying; SHA-256 inventory validation; isolated byte restoration before success; disk headroom checks; opt-in retention; private independent Compose and controller mount override. No game-specific backup code, external dependency, public endpoint, live deployment or off-host service was introduced.

`apps/docker-controller/service.mjs` optionally acquires the same on-disk instance lock as the worker, including during no-op lifecycle checks and unresolved operation timeouts. Existing deployments retain behavior until explicitly configured; deploying backups requires the shared directory and controller setting described in [the runbook](PHASE_6_BACKUP.md). Worker configuration maps stable registry IDs to approved mounts; Docker identity validation is reused unchanged.

Archives are directories containing portable data paths and a versioned JSON manifest. A verified marker records successful isolated restoration; it does not establish game-level recovery or power-loss durability. Failed/incomplete archives and stale crash locks are preserved. Retention is disabled in the example and requires a reviewed policy before activation.

## Evidence

- Initial focused runtime/lifecycle run: 18 passed, no failures/skips/cancellations.
- Intermediate complete `npm test`: 606 passed, no failures/skips/cancellations. Log: `%TEMP%/atlas-phase6-full.log`.
- Final complete `npm test`: 609 passed, no failures/skips/cancellations, after all runtime changes. Log: `%TEMP%/atlas-phase6-final.log`.
- Final focused backup runtime and new read-only Compose checks: 13 passed, no failures/skips/cancellations. Command: `node --test tests/phase6-backup.test.mjs infrastructure/checks/backup.check.mjs`.
- Existing `npm run check:infrastructure`: all eight checks passed. Log: `%TEMP%/atlas-phase6-compose.log`.
- Worker entrypoint/module Node syntax checks passed. Whitespace checks passed with normal LF-to-CRLF notices.

Tests recover Minecraft-shaped fixture bytes and empty directories; reject corruption, unsafe manifest paths, wrong instance IDs and existing recovery destinations; prove stopped/clean-exit and expected-volume requirements; demonstrate persistent lock exclusion after controller restart; verify opt-in retention, schedule retry/shutdown, disk headroom and an unfamiliar compatible game type. Compose checks parse configuration only and never contact the Engine or create resources.

Windows Node 20.15.1 initially failed before test loading with the previously documented `EPERM` resolving the Windows user directory. Tests ran with required process access. Local Git writes likewise required permission to access the repository index. No test, assertion, CI setting or dependency was removed or weakened.

## Remaining acceptance and preservation

Actual Linux mount/socket permissions, image build, resource overhead, disk capacity, real graceful Minecraft save and isolated client gameplay restoration are unexecuted. Operators must approve deployment and production restoration separately. The Docker socket remains host-privileged even when mounted read-only. Manual Docker operations can bypass coordination; trusted host configuration and quiescence are mandatory. Failure reporting uses bounded local JSON logs; an external notification receiver remains operator-configured.

All pre-existing untracked reports/tests were preserved and excluded from Phase 6 commits. Commits are local and forward-only, with at least 120 real elapsed seconds between milestones. No push, merge, history rewrite, production volume access or deployment occurred.
