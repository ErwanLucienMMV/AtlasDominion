# Phase 9 security feature review — 2026-10-26

The security, private authentication, Discord signature and native-port safeguards already exist. This review preserves those implementations and closes one confirmed bind-mount identity gap. It performs no provisioning, image execution, live Docker operation or deployment.

## Confirmed gap and correction

`posix.normalize` retains trailing separators. The protected-path overlap check rejected `/var` and `/var/lib`, but accepted `/var/`, `/var/lib/`, and normalized `/var/lib/../lib/`. Appending another separator during the ancestor comparison produced a double separator and missed the protected Docker/containerd storage descendants. The gap requires administrator-controlled provisioning drift; Discord still cannot choose mounts or create containers.

The controller now removes the normalized source's final separator before checking overlap, preserving `/` explicitly. This uses the existing protected-path policy. Ordinary `/srv/game-data/`, `/var/lib/games/world/` and `/var/lib/docker-other/` binds remain supported. No existing test or configuration is changed.

The new `tests/phase9-security-review.test.mjs` first reproduced **six failures and three passes**. After the correction all nine pass: five sensitive parent-path forms are rejected, three ordinary data paths remain supported, and `DockerAccess.inspect` rejects the unsafe mount before returning a pinned mutation handle.

## Executed verification

- `node --test tests/phase9-security-review.test.mjs tests/controller-security.test.mjs tests/controller-isolation-shutdown.test.mjs tests/phase7-security-regressions.test.mjs tests/phase9-adversarial.test.mjs`: **110 passed**, zero failures/skips/cancellations.
- `node --test tests/controller-http.test.mjs tests/discord-security.test.mjs tests/discord-http.test.mjs tests/phase9-ingress-adversarial.test.mjs`: **49 passed**, zero failures/skips/cancellations. Output: `%TEMP%/atlas-phase9-security-review-http.txt`.
- `git diff --check`: passed with the repository's existing LF-to-CRLF normalization notices.

These suites cover fixed-size bearer comparisons, guild/member authorization, exact label/name/restart/port identity, privileged/shared-namespace and management-network rejection, signed raw-body ingress, separate metrics credentials and real loopback HTTP framing/admission boundaries. The current run uses Windows Node 20.15.1. The initial sandboxed reproduction failed before imports with `EPERM` resolving the workspace parent; actual execution used approved sandbox exceptions.

## Remaining acceptance gates

Mock Engine responses and loopback servers do not prove live Linux permissions, runtime image users, actual socket access, external network isolation, native TCP/UDP reachability, reverse-proxy TLS behavior or real Discord registration. The existing operator gates in [Phase 9 validation](PHASE_9_VALIDATION.md) and [recovery](RECOVERY.md) remain. Docker socket holders retain host-administrative capabilities even with a read-only socket mount.

Changes in this milestone are limited to `apps/docker-controller/docker.mjs`, the new focused security regression and this report. Existing untracked Phase 0–6 reports/tests remain preserved and excluded. Nothing is pushed.
