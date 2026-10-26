# Phase 9 recovery and monitoring review — 2026-10-26

Phase 9 was already implemented before this review. Its recovery CLI, durable-intent replay, persistent backup exclusion, event reconnection, alert fixtures and read-only verification workflow remain in place. This milestone closes an additional monitoring configuration boundary and records fresh recovery regression evidence.

## Confirmed issue and correction

`LifecycleObserver` validated its sample deadline but accepted unchecked `intervalMs` and `retryMs` constructor options. Invalid values could reach Node's interval/retry timers, including values above the signed 32-bit millisecond limit. Timer coercion/clamping could turn an intended long delay into rapid polling or reconnection. The application entrypoint uses safe defaults; this finding concerns supplied constructor configuration.

Both options now require safe integer milliseconds from **1 through 2,147,483,647**, matching the existing sample-deadline range. Reconciliation still defaults to 15 seconds and event retry to one second. No scheduler, lifecycle mutation, archive format, CI job or infrastructure setting changes.

The new regression suite covers invalid values independently for each option, both valid boundaries, unchanged defaults, retry timing after a rejected event connection, cancellation at shutdown, and successful sampling recovery after a reconciliation failure. Failure retains the prior resource evidence and timestamp while publishing degraded readiness; a healthy later pass restores readiness without fabricating an unexpected exit.

## Executed validation

- Before the source correction, the new suite reproduced **18 failures and 3 passes**. The failures were the missing configuration exceptions.
- After correction, the new suite plus existing Phase 5 monitoring/recovery, Phase 8 sampling, Phase 9 recovery and recovery-adversarial suites passed: **82 tests**, zero failures/skips/cancellations/TODOs, including all **21 new tests**.
- `git diff --check` passed. Git reports existing LF-to-CRLF normalization notices.

Reproduce the focused checks with:

```sh
node --test tests/phase9-recovery-review.test.mjs tests/phase5-monitoring.test.mjs tests/phase5-recovery-regressions.test.mjs tests/phase8-sampling-regressions.test.mjs tests/phase9-recovery.test.mjs tests/phase9-recovery-adversarial.test.mjs
```

Execution used Windows Node 20.15.1. The Windows sandbox initially prevented Node from resolving the workspace parent (`EPERM`); the checks then ran with an approved sandbox exception. The deterministic retry test uses Node's mock timer API, which emits its experimental API warning on this runtime. No warning or verification requirement was suppressed.

Local `promtool` remains unavailable; rule semantics require the existing CI checks or the commands in [the recovery runbook](RECOVERY.md). Full-suite and production Compose verification are coordinated separately by the parent worker. No hosted CI, real daemon interruption, reboot, production restoration, alert delivery or live game acceptance is claimed. Those operator gates and off-host backup limitations remain documented in the [Phase 9 requirement mapping](PHASE_9_VALIDATION.md) and recovery runbook.

## Preservation

Only `apps/docker-controller/monitoring.mjs`, the new `tests/phase9-recovery-review.test.mjs` and this report belong to this milestone. Existing untracked Phase 0–6 work remains excluded. The worker's commit is coordinated with the other feature commits to preserve a minimum two-minute interval using actual commit times. Nothing is pushed or deployed.
