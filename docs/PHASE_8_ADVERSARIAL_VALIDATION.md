# Phase 8 adversarial validation — 2026-10-25

## Scope and safety

This extends the synthetic extensibility requirements in PLAN.md and
PHASE_8_EXTENSIBILITY.md. Only two new test files and this report are added.
Core application code, dependencies, CI, existing tests and fixtures are unchanged.
Pre-existing untracked Phase 0–6 work is preserved. Nothing is committed or pushed.
Tests use in-memory Docker substitutes and authenticated loopback HTTP listeners;
they do not connect to Docker, Discord, production hosts or external services.
Backup configuration tests validate paths without creating archives or deleting data.

## Additional coverage

`tests/phase8-adversarial.test.mjs` adds 67 checks including nested subtests:

- Invalid last entries in a 50-game registry: execution and endpoint injection,
  unsupported adapters, malformed ports, numeric extremes, metric label injection,
  allowlist limits, unknown permissions and implicit restart authorization.
- Deep-copy isolation of validated registry data.
- Twenty kinds of runtime identity/isolation drift: privileges, namespaces,
  management networks, normalized host binds, Docker socket mounts, root identity,
  capabilities, seccomp, restart policy, memory limits, labels and public bindings.
  Rejection must leave no lifecycle mutation or lock; repair restores admission.
- Per-instance replay isolation, conflicting raw idempotency keys, operation-read
  authorization and policy revocation after an operation has completed.
- Invalid pagination, duplicate query parameters, provisioning fields and
  authentication before malformed-body parsing.
- Capacity reservations for paused, restarting and removing games; denied stop and
  discovery for an instance with empty access lists.

`tests/phase8-boundaries.test.mjs` adds 27 checks:

- Eighteen backup configuration boundaries, including cross-game ancestor/child
  path overlap, lock-directory overlap, traversal, invalid schedules and retention
  authorization.
- Six malformed resource samples: stale data must disappear locally, other games
  remain sampled, invalid numeric values never reach metrics, and sampling recovers.
- Audit-write failure blocks admission across the fleet until durable replay
  succeeds; no start occurs during the failure and reservations recover.
- Replacing a container after accepted audit cannot redirect a pinned start.
- A deterministic stalled-stats reproducer, described below.

## Confirmed availability limitation

A single unresolved Docker `stats()` promise stalls resource sampling of every
later instance. Additional refresh calls return while the original poll remains
pending. An authenticated `/v1/health` call still returns HTTP 200 with
`{"ready":true}` because reconciliation can succeed independently of resource
sampling. The reproducer releases the promise in `finally` and verifies recovery.

Root cause: LifecycleObserver.refresh awaits stats sequentially, has no per-sample
deadline and coalesces concurrent refresh calls. Health reflects reconciliation
and audit readiness, rather than sampling freshness. Thus a ready controller does
not establish that fleet monitoring is progressing. During the simulated stall,
later samples are absent; previously collected later samples could remain stale
because their deletion is also downstream of the unresolved call.

The test records existing behavior and is named as an availability limitation;
its passing result does **not** mean the issue is fixed. This extends the slow/hung
Engine limitation already documented in PHASE_8_EXTENSIBILITY.md. A future core
change should bound sampling time, account for unresolved underlying requests,
and expose freshness/degradation without weakening lifecycle admission safety.
No core fix is included because Phase 8 explicitly excludes core source changes.

## Validation and interpretation

Final executed results:

- Focused Phase 8 suites: **108 passed**, zero failures/skips/cancellations/TODO
  (2.59 seconds), including **94 new checks** and 14 existing checks.
- Full `npm test`: **1006 passed**, zero failures/skips/cancellations/TODO
  (47.50 seconds), including pre-existing untracked suites without modification.
- Registry CLI: both manifests validated together; no Docker operations.
- `git diff --check`: passed. Additional no-index whitespace checks of the three
  new untracked files found no whitespace errors; Git only warned about LF-to-CRLF
  normalization (no-index returns 1 because the files differ from an empty file).
- Full TAP logs: `%TEMP%\atlas-phase8-adversarial-final-full.txt` and
  `%TEMP%\atlas-phase8-adversarial-final-focused.txt`.

The initial focused adversarial run exposed an incorrect test assumption:
ControllerClient deliberately hashes action and instance into Discord-derived
idempotency keys. The test now sends identical raw keys directly to the controller
to check its conflicting-action guard, while retaining HTTP replay and access checks.
No existing assertions were removed or weakened.

Node initially failed before loading tests with sandbox `EPERM` resolving
`C:\Users\erwan`. Execution with the workspace sandbox exception succeeded.
No external information or new dependencies were used.

Reproduce with installed pinned dependencies and Node 20 or newer:

```sh
node --test tests/phase8-adversarial.test.mjs tests/phase8-boundaries.test.mjs tests/phase8-extensibility.test.mjs tests/phase8-scale.test.mjs
node scripts/validate-registry.mjs tests/fixtures/phase8/instance.json tests/fixtures/instance.json
npm test
git diff --check
```

No unauthorized provisioning or access bypass was reproduced by these cases.
This is bounded mock evidence, not a proof of security. Real host exposure,
Docker daemon transport failures, firewall behavior, game-image compromise,
hardware capacity, gameplay and save consistency remain live acceptance gates.
Phase 9 production hardening remains the next documented phase.
