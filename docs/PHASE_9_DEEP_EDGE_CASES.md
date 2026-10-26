# Phase 9 deep edge-case validation — 2026-10-26

Added **80 tests: 63 passed, 17 failed** across four new test files, plus one isolated child-process fixture. The final full run executed **1,264 tests: 1,247 passed, 17 failed**, with zero skipped, cancelled or TODO tests. All 1,184 baseline tests still pass. The failing assertions remain enabled. This delivery adds tests and this report; it does not fix application code.

Requirements were taken from `AGENTS.md`, `PLAN.md` Phase 9, `SECURITY.md`, `docs/PHASE_2_CONTROLLER.md`, `docs/PHASE_3_DISCORD.md`, `docs/PHASE_6_BACKUP.md`, `docs/PHASE_7_GAMES.md`, `docs/PHASE_8_EXTENSIBILITY.md`, the existing Phase 9 reports and `docs/RECOVERY.md`. No external vulnerability database or documentation was queried.

## Findings and priority

| Finding | Failed tests | Interpretation |
|---|---:|---|
| Asynchronous lock-release failure terminates the controller process | 2 | High availability priority; confirmed child-process termination |
| CPU/PID limits can disappear without preventing controller admission | 6 | Production hardening gap; requires provisioning/runtime drift |
| Cross-game or shared bridge attachment passes identity checks | 3 | Network isolation gap; requires provisioning/runtime drift |
| Appending after valid unterminated audit JSON breaks future replay | 2 | Recovery/availability defect; confirmed with real files |
| Linked manifest metadata is accepted despite the no-links policy | 2 | Lower-priority policy consistency gap; no checksum bypass demonstrated |
| Concurrent calls to one lock release function are not idempotent | 1 | Lower-priority concurrency defect; current ordinary callers release sequentially |
| Missing runtime user is accepted | 1 | Defensive validation gap for incomplete Engine snapshots, not a proven root-user bypass |

### Controller process termination on cleanup failure

`apps/docker-controller/service.mjs:163` starts execution with `void this.execute(...)`. Its `finally` block awaits `unlock` at line 260 without handling rejection. `unlock` awaits the filesystem lock release, whose `rmdir` can fail.

Both start and stop child-process fixtures create a new temporary persistent lock directory and insert a new evidence file during a simulated Engine mutation. Cleanup reaches `ENOTEMPTY`; Node **20.15.1 exits with code 1** through an unhandled promise rejection. The child never reaches its scheduled alive/readiness report. The evidence file and persistent lock remain. This is not merely a failed request: the whole controller process ends. No parent test runner rejection handler masks the default child-process behavior.

The reproduction uses a nonempty lock as a deterministic filesystem failure. Permissions, I/O and other release failures need their own deployment checks; their process impact is an inference from the same uncaught await. No unauthenticated caller is shown to write the protected lock directory.

Suggested correction: explicitly handle asynchronous execution/cleanup rejection, mark readiness unhealthy, retain ownership/evidence and expose a sanitized operational failure. Never remove an evidence-bearing lock to make cleanup succeed. Review operation/audit semantics when a successful Engine mutation is followed by failed cleanup.

Evidence: `tests/phase9-process-faults.test.mjs` and `tests/fixtures/phase9/lock-release-child.mjs`.

### Runtime CPU/PID and network drift

`verifyIdentity` checks memory, labels, ports and selected isolation fields, but does not check CPU or PID ceilings. Approved-label Palworld snapshots pass with CPU control fields set to zero, `PidsLimit` equal to zero or minus one, or the PID limit omitted. End-to-end service tests confirm that removing CPU or PID limits after healthy reconciliation still produces an admitted operation and **one simulated start**.

Admission CPU reservations account for declared budgets; they do not constrain a running process. Unbounded CPU/process consumption can therefore escape that accounting if provisioning drifts. Actual host exhaustion, fork behavior and Docker enforcement were not exercised. Existing Compose templates still declare limits and their configuration checks pass.

The verifier rejects named management networks but accepts an extra `atlas-game-minecraft-survival` or default `bridge` attachment on the Palworld fixture. An end-to-end test confirms a simulated start after the foreign game network is added. This conflicts with the documented intent of distinct game bridges and exposes a possible lateral path to peers. Peer connectivity and accessible services were not probed. Discord cannot create containers or attach networks; administrator-controlled drift is a prerequisite.

Suggested correction: validate reviewed positive CPU/PID ceilings, accounting for Engine CPU representations, and establish explicit permitted networks per instance. Do not hardcode game titles or infer approval from an arbitrary network name. Registry/provisioning policy changes need review before implementation.

Evidence: `tests/phase9-runtime-drift.test.mjs`.

### Audit tail accepted on startup, then corrupted by append

`AuditLog.desiredStates` accepts a final complete JSON object without a newline. `AuditLog.append` then appends the next JSON object directly. The resulting bytes contain `...null}{"timestamp"...` on one line; the next replay throws `SyntaxError`. The controller entrypoint requires replay before serving, so this can block the next startup.

Both start-to-stop and stop-to-start sequences reproduce the failure while preserving all original bytes. A missing terminal newline models an imported/partially written final record; it does not prove a particular power-loss or filesystem failure sequence. Normal LF, CRLF and CR endings, concurrent appends and midnight rollback pass.

Suggested correction: safely account for a complete unterminated final record before appending, without rewriting existing history. Damaged partial JSON must continue failing closed and remain available for investigation.

Evidence: `tests/phase9-storage-faults.test.mjs`.

### Lower-priority defensive findings

**Manifest hardlinks:** `verifyArchive` reads `manifest.json` directly while payload inventory rejects linked files. Hardlinking a manifest to another fixture path still permits verification and restoration. These two failures test a strict reading of the documented no-links archive policy; no mismatch of payload bytes or SHA-256 bypass was demonstrated. Archive storage is already a trusted boundary. Consider checking metadata file type/link count before reading; do not treat checksums as authenticity protection.

**Concurrent release:** the release function checks `released` before awaiting `rmdir`, then sets the flag afterwards. Sixteen concurrent calls can enter deletion together; multiple calls reject instead of sharing one successful release. Sequential release remains supported. Current normal callers are sequential, so this is a latent concurrency issue rather than demonstrated duplicate-owner data loss. A shared release promise could preserve idempotence, retaining failures for operator investigation.

**Missing user:** an omitted `Config.User` passes `unsafeIsolation`. Real Engine responses normally provide this field, and explicit empty/root/zero identities remain rejected. This test recommends failing closed on incomplete identity evidence. It does not demonstrate that an actual root-running Engine container bypasses inspection. Existing compatibility fixtures also omit this field; any correction must review that contract and preserve intended coverage.

## Passing coverage

- All **39 new ingress checks** pass: real loopback duplicate signature headers, chunk trailers, legal chunk extensions, failed-signature-to-valid-request pipelining, rotating service tokens, metrics-token separation, absent authorization on a subsequent persistent request, and rejection of actor context on health.
- Ed25519 tests exercise exact inclusive five-minute boundaries and reject one millisecond beyond either side, changed whitespace, BOM insertion, Unicode normalization and altered body bytes.
- Runtime negatives preserve hard-memory, native TCP/UDP/address identity, duplicate bindings, management-network exclusion, explicit root rejection, protected read-only parent mounts and normalized socket destinations.
- Same-key operation replay and polling remain inaccessible to a non-authorized actor.
- Storage checks preserve damaged audit evidence, append ordering across clock rollback, symlink/junction rejection, nested data restoration and evidence-bearing lock exclusion.

## Executed verification

Environment: Windows, Node **20.15.1**. Logs are in `%TEMP%`.

| Command/run | Result | Log filename |
|---|---|---|
| Baseline `npm test`, before additions | 1,184 passed; 0 failed; 71.37 s | `atlas-phase9-deep-baseline-run.txt` |
| Runtime drift suite | 21 tests: 11 passed, 10 failed | `atlas-phase9-deep-runtime.txt` |
| Storage fault suite | 18 tests: 13 passed, 5 failed | `atlas-phase9-deep-storage.txt` |
| Isolated process fault suite | 2 tests: 0 passed, 2 failed | `atlas-phase9-deep-process.txt` |
| Ingress continuity suite | 39 passed; 0 failed | `atlas-phase9-deep-continuity.txt` |
| Final `npm test` | 1,264 tests: 1,247 passed, 17 failed; 77.18 s | `atlas-phase9-deep-full.txt` |
| `npm run check:production` | 15 passed; 0 failed; 41.45 s | `atlas-phase9-deep-production.txt` |

All test runs above have zero skipped/cancelled/TODO tests. The full log contains the existing mock-timer experimental API warning; no warning was suppressed. The initial sandboxed baseline failed before loading tests with the documented Windows parent-directory `EPERM`; actual runs used sandbox exceptions. Compose checks only render configuration and do not mutate Docker resources.

Focused reproduction:

```powershell
node --test tests/phase9-runtime-drift.test.mjs tests/phase9-storage-faults.test.mjs tests/phase9-process-faults.test.mjs tests/phase9-ingress-continuity.test.mjs
npm test
npm run check:production
```

`promtool` is not installed locally. Neither Prometheus rule syntax nor semantic fixtures were executed in this review. Required reproduction remains:

```powershell
promtool check rules infrastructure/monitoring/alerts.yml
promtool test rules tests/fixtures/phase9/alerts.test.yml
```

Live Linux permissions, resource enforcement, Docker transport failures, real reboot/restore, external native-port exposure, reverse-proxy TLS, actual Discord acceptance, alert delivery and hosted CI remain the gates in `PHASE_9_VALIDATION.md` and `RECOVERY.md`. No unauthenticated remote compromise was established by this review. Passing synthetic tests do not certify a production server as secure or exhaust every possible edge case.

## Preservation and delivery

The four new suites, one child fixture and this report are the only additions from this review. No application source, existing test, CI workflow, dependency or lockfile was changed. Existing untracked Phase 0–6 work remains untouched. The branch is `main`; its pre-existing `origin/main` tracking reference is reported gone, so no remote divergence claim is made. Nothing was staged, committed, pushed, merged, deployed or deleted. New temporary evidence is retained.
