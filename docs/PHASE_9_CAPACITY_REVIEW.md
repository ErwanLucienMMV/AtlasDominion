# Phase 9 capacity and ingress review — 2026-10-26

The existing Phase 9 implementation already bounds HTTP handlers/connections,
request deadlines, controller admission, retained operations and resource
reservations. This review preserves those limits and all existing tests.

## Confirmed preflight deadline gap

Preflight awaited dependencies through a promise/timer race without checking
elapsed monotonic time after resolution. A synchronous dependency could delay
the event loop past the deadline and resolve before the overdue timer callback.
Unlike the execution path, preflight could then accept and execute new work.

A mock-only reproduction with a 1,050 ms budget and a 1,100 ms synchronous
inspection returned status 202 and performed one simulated Engine start.
No real Docker daemon or game data was involved.

`apps/docker-controller/service.mjs` now rejects an exhausted remaining budget
before waiting and checks the monotonic deadline again after resolution. Pending
dependency tracking and timeout lock ownership remain intact. The correction
does not claim to interrupt synchronous code: it prevents subsequent admission
or mutation once control returns after expiry.

Four new regression cases cover start and stop with blocking work both before
the wait begins and after the race is installed. They require TIMEOUT, no
accepted audit, no retained operation, no lifecycle mutation, admission-slot
release and recovery through reconciliation followed by a fresh request.

## Executed validation

- Lifecycle, Phase 9 safeguards/adversarial/fix regressions and Phase 2 edge
  cases: **139 passed**, zero failures/skips/cancellations, 14.88 seconds.
  This run included the initial two before-wait cases. Log:
  `%TEMP%/atlas-phase9-capacity-review.txt`.
- Expanded four-case boundary suite: **4 passed**, zero failures/skips/
  cancellations, 4.78 seconds. Log:
  `%TEMP%/atlas-phase9-capacity-boundaries.txt`.
- Coordinated final `npm test`: **1,184 passed**, zero failures/skips/
  cancellations/TODO, 49.77 seconds. Log:
  `%TEMP%/atlas-phase9-final-worker-validation.txt`.
- Coordinated `npm run check:production`: **15 passed**, zero failures/skips,
  27.16 seconds. Configuration rendering only. Log:
  `%TEMP%/atlas-phase9-current-production.txt`.
- `git diff --check` passed, with existing LF-to-CRLF normalization notices.

Commands:

```powershell
node --test tests/phase9-capacity-review.test.mjs tests/controller-lifecycle.test.mjs tests/phase9-safeguards.test.mjs tests/phase9-adversarial.test.mjs tests/phase9-fix-regressions.test.mjs tests/phase2-edge-cases.test.mjs
node --test tests/phase9-capacity-review.test.mjs
```

The first sandboxed reproduction failed before loading imports with Windows
EPERM resolving the workspace parent. Actual reproduction and verification used
approved sandbox exceptions. No test was bypassed or weakened. Real reverse
proxy, Linux/Docker resource enforcement and measured host capacity remain the
operator acceptance gates documented in the existing Phase 9 runbooks.
