# Phase 9 production hardening

This phase delivers repository safeguards and repeatable verification. It does not authorize deployment, daemon restarts, host reboots, firewall changes or restoration over existing data. Earlier live game acceptance gates still apply.

## Request and capacity safeguards

Both Nest HTTP applications limit active handlers to 32. Excess requests receive sanitized HTTP 429 responses. A slot remains owned until its handler settles, including after client disconnect. Discord deferred work separately retains its existing bounded job reservation and per-member rate limit. Unsigned traffic is rejected before command processing; no IP-based identity is persisted.

Node servers allow at most 128 simultaneous connections and 100 requests per socket, with 5-second header and keep-alive limits, a 10-second request-body deadline and 30-second socket inactivity timeout. These bound transport exposure; they do not cancel Docker work. Reverse proxy controls and container limits remain necessary against ingress floods.

The controller accepts at most `maxPendingRequests` queued/active admission requests (default 100), independently of retained operations (`maxOperations`, default 10000). Both must be positive safe integers. Queue saturation returns `RESOURCE_EXHAUSTED` before inspecting Docker or writing audit records. Existing atomic memory/CPU reservations, registry limits and per-instance exclusion remain mandatory. Configure admission budgets only after reserving measured capacity for the OS, existing TCP 4242 workload and infrastructure.

An execution inspection returning after timeout cannot begin a start or stop. In-flight mutations cannot be undone by a deadline: retain their instance lock until the underlying work settles, report timeout, and reconcile before accepting new work. Never clear a lock merely to make admission succeed.

## Milestone-one validation

`node --test tests/phase9-safeguards.test.mjs tests/controller-lifecycle.test.mjs tests/controller-http.test.mjs tests/discord-http.test.mjs`: 28 passed, zero failures/skips. The new checks exercise admission saturation/recovery, HTTP work ownership, transport configuration and late inspection for both start and stop. Existing ingress signature/authorization and lifecycle tests also pass.

The first sandboxed Node launch failed before test loading with Windows `EPERM` on the workspace parent. The same tests passed with a sandbox exception; no assertions were changed to accommodate this environment.

`npm test`: 1,026 passed, zero failures/skips/cancelled (85.74 seconds). Full output: `%TEMP%/atlas-phase9-m1-full.txt`. This includes the preserved untracked tests. `git diff --check` passed with existing LF-to-CRLF notices.
