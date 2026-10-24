# Phase 2 validation

Phase 2 implements the generic private NestJS/Dockerode controller. No production deployment or real game operation was performed. See [configuration, API, security review and limitations](PHASE_2_CONTROLLER.md).

## Evidence

- Full `npm test` run: 162 passed, zero failed or skipped, including the pre-existing untracked Phase 0/1 documentation acceptance tests. The audit persistence test was added afterward and passed in the targeted suite.
- Final targeted `node --test tests/controller-audit.test.mjs tests/controller-security.test.mjs tests/controller-lifecycle.test.mjs tests/controller-http.test.mjs`: 11 passed. Covers persistent sanitized audit, real Nest HTTP authentication and input limits, multiple same-game instances, unknown/unauthorized instances, registry duplicates, invalid labels/restart policies/ports/binding addresses, missing container versus Docker outage, start/stop idempotency, replay, concurrent requests, atomic capacity admission, running-container reconciliation and timeout lock retention.
- `npm run check:infrastructure`: all 7 Compose checks passed. Configuration validation only; no containers started.
- Dependency installation with pinned versions and `multer` 2.5.0 security override: online advisory audit reports zero vulnerabilities.
- `git diff --check`: passed. Git may print LF-to-CRLF working-copy normalization notices on this Windows checkout.

The initial sandboxed Node test attempt failed before loading tests because Windows denied parent-directory `lstat`; running the unchanged suite with the required process permission succeeded. npm initially could not verify the local proxy certificate. Installation used existing Windows trusted roots through `NODE_EXTRA_CA_CERTS`; TLS verification stayed enabled. No credentials or certificate files were added to the repository.

## Remaining checks and scope

Mock Engine tests validate controller behavior, not live Engine compatibility or game persistence. Before deployment, measure capacity, approve Discord policy and exact binding addresses, supply persistent audit storage and retention policy, and use the private networks. Single process only; in-memory keys/results do not survive restart. Audit files do survive when the approved persistent mount is supplied. Continuous events, historical event APIs and metrics remain Phase 5; Discord integration is Phase 3. Do not claim game readiness from Docker running state.

Existing four untracked Phase 0/1 acceptance files remain untouched and excluded from milestone commits. No push, merge, history rewrite, service deployment or destructive operation was performed.
