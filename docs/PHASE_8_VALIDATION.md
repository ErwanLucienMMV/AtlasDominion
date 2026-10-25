# Phase 8 validation — 2026-10-25

Scope: a synthetic unknown-game manifest, a reusable in-memory Engine harness, cross-service integration verification, 50-instance scale tests and documentation. The [acceptance mapping](PHASE_8_EXTENSIBILITY.md) connects each Phase 8 requirement to executable checks and describes operational limits.

## Executed checks

- `node scripts/validate-registry.mjs tests/fixtures/phase8/instance.json tests/fixtures/instance.json`: both manifests validated together; no Docker operations.
- `node --test tests/phase8-extensibility.test.mjs tests/phase8-scale.test.mjs`: **14 passed**, zero failures/skips/cancelled. The final focused run reported 5.20 ms for a coalesced mock poll of 50 instances; this is diagnostic evidence, not a host latency guarantee.
- `npm test`: **912 passed**, zero failures/skips/cancelled/TODO. This includes all 898 previously present tests and the 14 added checks. Pre-existing untracked Phase 0–6 tests were executed without editing or staging them. Full TAP output is retained at `%TEMP%\atlas-phase8-full.txt` (57.52 seconds).
- `git diff --check`: passed. Git emits existing LF-to-CRLF normalization warnings for text files.

The first sandboxed Node attempt failed before loading the test with `EPERM` resolving `C:\Users\erwan`. Tests and manifest validation passed with the same sandbox exception required in earlier phases. Initial Git staging was also denied because `.git` is read-only in the sandbox; the authorized milestone commit succeeded with an exception. No test assertions or verification requirements were bypassed or weakened.

Infrastructure configuration and application source are unchanged; no Docker image build, Compose deployment or real game execution was needed for this mock-only phase. No external information lookup or new dependencies were needed.

## Delivery and remaining gates

Milestone one adds the deny-by-default unknown-game fixture, mock Engine harness and API/Discord/lifecycle/monitoring/backup integration checks. Milestone two adds the 50-instance capacity, pagination, polling, cardinality, error and configuration checks plus acceptance documentation. Commits use actual creation times with at least two minutes between them; timestamps are not fabricated.

Existing untracked documentation/tests are preserved and excluded from the Phase 8 commits. Nothing is pushed. The configured `origin/main` tracking reference was already reported as gone at inspection; no remote integration or history rewriting was performed.

No live compatibility, gameplay, save consistency, real-host polling performance or production deployment is claimed. Slow/hung Engine behavior and production hardening remain Phase 9 work. Prior live acceptance gates remain outstanding. Phase 8 fulfills its synthetic extensibility scope without activating another game or changing core application logic.

## Corrective validation after adversarial review — 2026-10-25

The supplied [adversarial report](PHASE_8_ADVERSARIAL_VALIDATION.md) and its two test suites were inspected and reproduced: **108 Phase 8 checks passed**, including the deterministic hung-stats reproducer. Its success asserted the presence of an availability defect, not its absence. No access bypass was reproduced. Those supplied suites/report are preserved unchanged and included in the corrective commit for traceability; unrelated untracked Phase 0–6 work remains excluded.

Confirmed root cause: sequential `stats()` waits had no observer deadline, so an unresolved promise kept the whole sampling pass pending. Reconciliation could still succeed and report lifecycle readiness while later resource samples stopped progressing. Existing later-instance values could also survive behind the stalled call.

The observer now bounds each sampling inspection-plus-stats read to five seconds, passes an abort signal to Dockerode stats, and continues to later instances on timeout. It retains each unresolved sampling slot until the underlying work settles, preventing repeated polls from accumulating sampling requests for that instance. Late values never publish; a late inspection cannot start stats after its deadline. Shutdown aborts sampling without waiting indefinitely for a non-cooperative transport. Existing lifecycle admission, health responses, identity validation and reconciliation semantics are preserved.

After successful reconciliation, old resource values are cleared before sampling begins. Failed reconciliation preserves prior samples as evidence, as required by existing tests. Separate `atlas_resource_sampling_ready` and `atlas_resource_sampling_timestamp_seconds` gauges distinguish resource health from lifecycle health. The dashboard and `ResourceSamplingDegraded` rule expose incomplete or stale passes. The 50-instance cardinality assertion remains exact and now covers **761** series, including the two added global gauges. Existing assertions were retained; infrastructure assertions were extended to verify the new rule and panels.

`tests/phase8-sampling-regressions.test.mjs` adds **15 checks** covering the timeout, subsequent-server progress, stale-data removal, bounded unresolved ownership over repeated polls, late success/rejection, sampling-inspection timeout, abort-aware transport, prompt shutdown, malformed samples, reconciliation failure and invalid deadline values. The original short-lived stall reproducer is unchanged: it still observes the interval before the five-second deadline and manually releases its gate. The new regression waits through the configured deadline and proves progress and recovery.

Executed on the corrected application/test code:

- Phase 8 plus existing monitoring/regression suites: **203 passed**, zero failures/skips, including all 94 supplied adversarial checks and 15 new checks. Log: `%TEMP%\atlas-phase8-fix-focused.txt`.
- `npm test`: **1,021 passed**, zero failures/skips/cancelled/TODO (65.49 seconds). Log: `%TEMP%\atlas-phase8-fix-full.txt`.
- Final monitoring infrastructure suite: **3 passed**, zero failures/skips, verifying both the added wiring and prior requirements. Log: `%TEMP%\atlas-phase8-fix-infrastructure.txt`.
- `npm run check:infrastructure`: **11 passed**, zero failures/skips; configuration-only Compose rendering, with no image pulls or deployment. Log: `%TEMP%\atlas-phase8-fix-compose.txt`.
- Registry CLI: synthetic and existing Minecraft fixtures validated together; no Docker operations.
- `git diff --check` and staged whitespace checks: passed, with only existing LF-to-CRLF normalization warnings.

Node/Git operations used the previously required Windows sandbox exceptions. `promtool` is unavailable and Python's optional YAML package is absent; full Prometheus rule parsing/evaluation was not run. On an operator environment with Prometheus tools installed, run `promtool check rules infrastructure/monitoring/alerts.yml`. The dashboard JSON and alert wiring are covered by the monitoring infrastructure tests. No tools or dependencies were installed to bypass this limitation.

This correction changes generic observer behavior following explicit authorization to fix the reported defect; it does not require game-specific source changes for onboarding. Sequential waits across several slow instances can still lengthen a pass. Reconciliation, list/status and lifecycle requests remain outside the new sampling deadline and retain their existing transport timeouts. Read-only mock tests do not certify real daemon cancellation, host performance, game security or live save integrity. No running stack was reloaded, no production data was changed, and nothing was pushed.
