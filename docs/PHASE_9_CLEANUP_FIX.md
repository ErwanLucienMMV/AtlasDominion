# Phase 9 cleanup failure correction — 2026-10-26

The supplied deep edge-case review identified two controller process exits after
successful simulated Engine mutations, and one concurrent persistent-lock
release failure. These were confirmed before correction. The combined supplied
process/storage reproduction had 13 passes and seven failures; four of those
failures concern audit/archive findings corrected in a separate milestone.

## Cause and correction

Detached lifecycle execution awaited filesystem cleanup in its `finally` block.
A failed directory removal escaped that promise and terminated Node through its
default unhandled rejection behavior. Reconciliation could also report healthy
Docker state without accounting for failed cleanup ownership.

`unlock` now retains the persistent release function and in-memory lock, records
the failed instance, marks readiness unhealthy and raises only the sanitized
`DOCKER_UNAVAILABLE` service error. Execution handles cleanup rejection, and its
detached caller explicitly handles unexpected rejection. Docker reconciliation
cannot restore readiness while a release failure remains. No process-wide
rejection handler is introduced and no evidence-bearing directory is removed.

A successfully persisted Engine outcome remains completed: cleanup failure does
not claim that an actual start or stop failed. The retained operation lock and
unhealthy readiness separately expose the cleanup problem. Authorized idempotent
replay returns that original Engine outcome without repeating the mutation.

Persistent release callers now share one in-flight removal promise. Successful
release remains idempotent even if a subsequent owner acquires the same path.
Failed release preserves the directory and permits a later explicit retry;
the controller does not automatically retry failed removal during reconciliation.
An operator must investigate all ownership and evidence before arranging any
filesystem remediation. After explicit successful cleanup, a healthy
reconciliation is still required to restore readiness.

## Verification

The new six-case cleanup regression suite plus the two supplied child-process
cases and existing lifecycle, safeguard, deadline/audit and recovery suites
passed **38 tests**, with zero failures, skips or cancellations, in **15.62
seconds** on Windows Node 20.15.1. Log:
`%TEMP%/atlas-p9-cleanup-focused.txt`.

```sh
node --test tests/phase9-cleanup-regressions.test.mjs tests/phase9-process-faults.test.mjs tests/controller-lifecycle.test.mjs tests/phase9-safeguards.test.mjs tests/phase9-fix-regressions.test.mjs tests/phase9-recovery.test.mjs
```

The new cases check retained evidence and ownership for both actions, readiness
remaining unhealthy across reconciliation, sanitized synchronous cleanup errors
without an implicit second release attempt,
explicit recovery, shared concurrent rejection and old-owner release isolation.
The supplied child-process tests use Node's default rejection behavior and now
survive. Actual persistent filesystem permission/I/O failure, real Docker
mutations and production recovery are not claimed by these synthetic checks.

An intermediate run overlapped the separate identity correction before valid
fixtures were updated and failed identity validation; the final focused run
above uses the completed valid fixtures. Windows execution required the existing
sandbox exception for Node workspace imports. Full-suite verification is recorded
centrally after all milestones. Only this report, the new cleanup regression
file, `apps/docker-controller/service.mjs` and `libs/instance-lock.mjs` belong to
this corrective worker's commit. Existing tests and unrelated work are preserved.
