# Phase 6 validation

## Adversarial recovery corrections

The unchanged adversarial tests reproduced all five reported failures: **111 focused checks, 106 passed and five failed**. Evidence: `%TEMP%/atlas-phase6-fix-reproduce.log`. Causes were success reporting before lock cleanup, retention accepting incomplete markers, replacement exemption overflowing the retained set, an unchecked linked archive root and case-sensitive overlap comparisons on Windows.

`worker.mjs` now catches release failures before reporting success, validates restoration timestamps before any retention eligibility, checks the replacement marker before pruning and reserves its retained slot independently of clock ordering. `archive.mjs` rejects archive-root links before reading manifests. Both archive creation and worker configuration use native relative-path overlap checks from `libs/filesystem-paths.mjs`, preserving root and Windows case equivalence. No locks, damaged markers or failed archive evidence are silently repaired or discarded.

The unchanged focused tests passed **111/111** after the fixes. With eleven new independent recovery regressions, **122/122** focused runtime, static exposure and backup Compose checks passed, with no skips/cancellations. Log: `%TEMP%/atlas-phase6-fix-regressions.log`. Regressions cover invalid timestamp types/calendar dates, malformed replacement markers blocking deletion, rollback with `keep: 2`, success after release, failure evidence preservation and path root/case/sibling boundaries.

Final complete `npm test`: **718 passed**, zero failures/skips/cancellations, including all 707 pre-existing checks and the eleven new regressions; log `%TEMP%/atlas-phase6-fix-full.log`. All **12** existing application/monitoring and backup Compose checks passed; log `%TEMP%/atlas-phase6-fix-compose.log`. `git diff --check` passed with ordinary LF-to-CRLF notices. Runs used the previously documented Windows process access. Checks rendered Compose configuration only; no Engine resources were created.

Existing tests, untracked adversarial reports/tests, dependencies and CI were not changed. No production restore, deployment, push or history rewrite was performed. The original delivery evidence follows; real-host acceptance gates remain unchanged.

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
