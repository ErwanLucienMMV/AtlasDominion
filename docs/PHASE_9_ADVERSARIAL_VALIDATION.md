# Phase 9 adversarial validation — 2026-10-25

Added 108 executable tests in three new files. Final full suite: **1,140 tests, 1,127 passed, 13 failed**, no skips, cancellations or TODOs. The failures remain enabled. Application code, existing tests, dependencies and CI are unchanged. This is a test-and-report delivery; the findings below are not fixed.

## Scope and evidence

Requirements come from `AGENTS.md`, `PLAN.md` Phase 9, `SECURITY.md`, `docs/PHASE_9_HARDENING.md`, `docs/PHASE_9_VALIDATION.md`, and the controller, Discord, backup and recovery Markdown documentation. No external documentation or vulnerability database was queried. Markdown live acceptance gates remain in force.

Tests exercise real Nest applications on loopback with ephemeral ports, actual Ed25519 signatures, Node's HTTP parser and socket handling, real temporary archive/audit/lock files, and simulated Engine operations. No real game, Docker daemon mutation, deployment, image pull, host reboot, production restoration or firewall change was performed. All created fixtures are new temporary directories; existing files and backups were not touched.

## Findings

### 1. Parent-directory bind mounts bypass the Docker-storage exclusion

Priority: high security review; impact is conditional on provisioning drift and filesystem permissions. Three failing tests.

`apps/docker-controller/docker.mjs:11` checks whether a bind source equals or descends from a sensitive path. It does not check whether the source is an ancestor of a sensitive path. As a result, `/var`, `/var/lib`, and normalized `/var/lib/../lib` pass identity verification even though they include `/var/lib/docker` and `/var/lib/containerd`.

The test uses an otherwise approved identity, explicit nonroot UID, dropped capabilities and no-new-privileges. Verification does not raise `IDENTITY_MISMATCH`. A writable parent mount can expose host runtime data and other workloads' volume contents wherever filesystem permissions permit access. This is a runtime approval gap; it does not demonstrate that Discord can create a mount or that the tested nonroot UID can read every host file. Provisioning remains administrator-controlled.

Suggested correction: reject overlap in both directions with protected host paths. Preserve the documented allowance for ordinary game-data binds. Review sensitive-path coverage separately.

### 2. Recovery can invalidate its own source backup

Priority: high recovery/data-integrity review. One failing test plus an independent temporary-fixture confirmation.

`apps/backup-worker/archive.mjs:54` verifies the source archive, then creates the destination without excluding the archive's own `data` tree. Restoring to `<archive>/data/restored` succeeds and adds unmanifested data to the source archive. Subsequent `verifyArchive` rejects that same backup with `Archive integrity failure`.

Independent confirmation returned:

```json
{"restore":"fulfilled","archiveVerification":"rejected","integrityError":"Archive integrity failure","sourcePreserved":true}
```

The backup becomes invalid for future verified recovery; the original archived file bytes are not shown to be destroyed. This requires an operator-selected overlapping destination, not remote unauthenticated access.

Suggested correction: reject destination overlap with the archive payload before creating anything. Preserve the worker's supported `<archive>/restore-test` scratch destination, which is outside `data`; a passing test covers that distinction.

### 3. Terminal audit writes escape the lifecycle deadline

Priority: availability and completion-integrity review. Two failing tests, covering start and stop.

`apps/docker-controller/service.mjs:214` races Engine work against a timer, but the subsequent `finish(op, 'completed')` at line 215 awaits persistence without the remaining deadline. If the terminal audit stalls, the operation remains `starting` or `stopping` after its configured timeout. Releasing the audit later publishes `completed`, despite the elapsed deadline.

Both tests use a 1,050 ms timeout, wait 1,250 ms after entry into terminal persistence, and retain the lock until the injected dependency settles. Observations were `{atDeadline: starting, afterRelease: completed}` and the corresponding `stopping` case. A permanently stalled filesystem dependency can retain ownership indefinitely while terminal state never becomes timed out.

Suggested correction: include terminal persistence in a bounded completion path, report timeout without claiming cancellation, and retain ownership until unsettled persistence completes. Prevent a late write from upgrading a timed-out result to success.

### 4. Midnight clock rollback corrupts replay order and can suppress crash reporting

Priority: recovery and monitoring correctness. Two failing tests.

`apps/docker-controller/audit.mjs:27` replays daily files in filename order. After a clock correction crosses UTC midnight backwards, a later accepted operation is appended to the previous day's file. Restart then treats the older request in the next day's file as the newest intent.

The first test accepts `start` at October 26 00:00:02, then `stop` at October 25 23:59:59 after correction; replay incorrectly returns `wanted_running`. The inverse sequence incorrectly restores `wanted_stopped`. A second test feeds that inverse recovered intent into the real `Monitoring.observe`: a subsequent running-to-exited crash is suppressed. Audit bytes are preserved throughout.

There is no automatic game start on reboot in this implementation. The demonstrated effects are incorrect desired state and lost crash evidence, not an automatic restart.

Suggested correction: preserve durable acceptance ordering independently of wall-clock filenames. Do not rewrite or discard existing audit history; design backward-compatible replay explicitly.

### 5. The public request-body timeout is not an effective ten-second deadline

Priority: bounded ingress/availability review. One failing test.

A real loopback socket sends incomplete JSON with `Content-Length: 10` to the public Discord route and remains open after 12 seconds. The test allows two seconds beyond the documented ten-second body deadline and then destroys its own socket.

`libs/http-safety.mjs:17` sets `requestTimeout = 10000`, but Node 20.15.1's timeout checker uses a default `connectionsCheckingInterval` of 30,000 ms. This was confirmed from the installed runtime and its embedded `_http_server` source. Setting timeout properties alone does not guarantee closure at the claimed deadline. The existing 30-second inactivity limit and 128-connection ceiling still apply; this is not evidence of infinitely retained sockets or an external production flood.

Suggested correction: configure an appropriate checking interval before the server starts listening, or implement a bounded request timer. Validate both incomplete headers and bodies on every supported Node version and through the actual reverse proxy.

### 6. Valid signed PING responds with HTTP 201

Priority: Discord protocol compatibility review; live rejection is unproven. One failing test.

A valid signed PING of exactly 65,536 bytes returns the correct PONG JSON with status **201**, while the regression expects HTTP **200**. Nest's installed `router-response-controller.js` defaults POST handlers to `HttpStatus.CREATED`; `apps/discord-api/http.mjs` does not override that status for successful replies.

The local Markdown requires a valid PING handshake but does not spell out its numeric success status. Therefore the confirmed observation is HTTP 201, and the compatibility impact remains a hypothesis requiring review against the documented protocol reference or an approved real Discord handshake. No claim is made that live Discord rejected it. A separate passing test confirms that a signed 65,537-byte payload is rejected with HTTP 400, independently of this status issue.

Suggested correction after protocol review: explicitly select the required success status and cover PING, deferred responses, authorization replies and autocomplete separately.

### 7. Controller accepts timeout values outside Node's timer range

Priority: configuration correctness. Three failing tests.

`apps/docker-controller/service.mjs:15` accepts any positive safe-integer timeout greater than the stop window. It accepts 2,147,483,648; 4,294,967,296; and `Number.MAX_SAFE_INTEGER`. These exceed Node's signed 32-bit millisecond timer range and are clamped to approximately one millisecond when passed to `setTimeout`. An apparently longer timeout can therefore produce immediate operation failures. Normal documented timeouts are below this limit.

Suggested correction: reject values above 2,147,483,647 before creating timers. A passing boundary test preserves acceptance of the largest representable timeout without scheduling a long-running timer.

## Passing coverage

- Internal metrics credentials cannot read health, list, status or operations, or request start/stop. Service credentials cannot invoke separately authenticated metrics, including encoded and alternate path spellings.
- Controller and public Discord raw HTTP reject conflicting/duplicate framing, length-plus-chunking and invalid transfer encodings before service access. A second authorization header does not authorize an invalid first header.
- Thirty-two real blocked HTTP handlers reject excess work, retain ownership after disconnect, and recover after work settles. The hundred-request keepalive ceiling retires the socket and admits later traffic on a new connection.
- Invalid signatures, timestamps, envelope shapes, media types, compressed bodies and stale/future signed replays dispatch no work. Oversized signed ingress fails closed.
- One hundred identical lifecycle requests create one operation, accepted audit and simulated Engine mutation. A twenty-instance burst cannot overcommit one instance's memory/CPU budget. Invalid queued requests release all admission slots.
- Privilege, namespace, management-network, capability, root-user, socket-mount, label, restart-policy, extra-port and wildcard-bind negatives remain rejected.
- Binary/empty-file/empty-directory recovery, concurrent restores and existing-output preservation pass. Path traversal, bit flips, truncation, unknown instances, duplicate/null manifest entries, extra payloads and hardlinks fail closed and preserve evidence.
- One hundred persistent-lock contenders admit one owner; release is idempotent and subsequent ownership works. Late Engine failure after timeout retains terminal failure without logging the private injected error.

## Executed validation

Environment: Windows, Node **20.15.1**, Docker Compose **v2.35.1-desktop.1**.

| Run | Result | Log in `%TEMP%` |
|---|---|---|
| Baseline `npm test`, before additions | 1,032 passed; zero failures/skips | `atlas-phase9-adversarial-baseline-unrestricted.txt` |
| Final three-file focused run | 108 tests: 95 passed, 13 failed; zero skips/cancellations/TODOs; 16.00 seconds | `atlas-phase9-adversarial-focused-final.txt` |
| Final `npm test` | 1,140 tests: 1,127 passed, 13 failed; zero skips/cancellations/TODOs; 83.04 seconds | `atlas-phase9-adversarial-full-final.txt` |
| `npm run check:production` | 15 passed; zero failures/skips; 41.54 seconds; configuration renders only | `atlas-phase9-adversarial-compose.txt` |
| Existing Phase 8 scale suite investigated separately | 12 passed; zero failures/skips | `atlas-phase9-phase8-rerun.txt` |

Tracked/staged `git diff --check` and explicit `git diff --no-index --check` checks of all four new files passed. Git reported its existing LF-to-CRLF normalization warnings.

An intermediate full run with 104 new cases had 1,136 tests, 1,123 passed and 13 failed. Twelve failures were the then-current new findings; the other was the existing `simultaneous fleet starts reserve CPU atomically and never evict another game` test (`tests/phase8-scale.test.mjs:51`). Its hardcoded `nebula-00` stop unexpectedly did not reject. The test assumes that instance is among the three HTTP requests admitted first; simultaneous HTTP request arrival need not preserve submission order. This ordering explanation is an inference from the test/harness, not instrumented proof of that run's admitted IDs. No existing assertion was changed. The focused rerun and final full run passed this test. Preserve the intermediate log `atlas-phase9-adversarial-full.txt` for investigation.

The initial sandboxed baseline failed before loading tests with Windows `EPERM` while resolving `C:\Users\erwan`. Actual test runs used approved sandbox exceptions; no test was bypassed. The sandboxed `docker compose version` also reported access denied reading the user's Docker configuration; the actual configuration checks completed successfully outside that sandbox.

Local `promtool` remains unavailable. Prometheus semantic fixtures were not executed here. Reproduction commands retained by the existing docs/CI are:

```powershell
promtool check rules infrastructure/monitoring/alerts.yml
promtool test rules tests/fixtures/phase9/alerts.test.yml
```

Reproduce all new tests with:

```powershell
node --test tests/phase9-adversarial.test.mjs tests/phase9-ingress-adversarial.test.mjs tests/phase9-recovery-adversarial.test.mjs
npm test
npm run check:production
```

Do not interpret the passing checks as Linux isolation, real Docker socket permissions, actual image security, external firewall/TLS isolation, real Discord acceptance, durable power-loss recovery or gameplay certification. Those remain the existing operator-approved live gates. No dependency advisory scan or exploitability certification is claimed.

## Delivery and Git preservation

Added only:

- `tests/phase9-adversarial.test.mjs`
- `tests/phase9-ingress-adversarial.test.mjs`
- `tests/phase9-recovery-adversarial.test.mjs`
- `docs/PHASE_9_ADVERSARIAL_VALIDATION.md`

All four remain untracked for review. Pre-existing untracked Phase 0–6 reports and tests remain present and unchanged. No tracked file or staged change was modified. Current branch is `main` at `fe35c48`; its configured `origin/main` tracking reference was already reported as gone, so current remote divergence cannot be established locally. No fetch, integration, commit, push or pull request was performed.
