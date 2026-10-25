# Phase 7 adversarial validation - 2026-10-25

Requirements: `AGENTS.md`, `SECURITY.md`, `ARCHITECTURE.md`, `OPERATIONS.md`,
`SERVER_REGISTRY.md`, `PLAN.md`, `docs/ADDING_A_GAME.md`, and the Phase 5-7
runbooks and validation records. Markdown requirements supplied the expected
behavior; implementation inspection supplied test entry points. No external
image documentation was revalidated and no external service was contacted.

Added 151 executable tests across three files, with a separate fixture helper:

| File | Tests | Passed | Failed |
| --- | ---: | ---: | ---: |
| `tests/phase7-adversarial.test.mjs` | 78 | 63 | 15 |
| `tests/phase7-backup-boundaries.test.mjs` | 60 | 57 | 3 |
| `tests/phase7-exposure.test.mjs` | 13 | 13 | 0 |

## Findings

Five runtime isolation checks fail for each of V Rising, Zomboid and Palworld
(15 failures). `verifyIdentity()` in `apps/docker-controller/docker.mjs` accepts:

- Added `SYS_ADMIN` capability.
- Removal of `CapDrop: ['ALL']`.
- Removal of `no-new-privileges`.
- An explicit `seccomp=unconfined` override.
- A host block-device mapping such as `/dev/sda`.

The candidate Compose files specify capability dropping and no privilege
escalation and contain no device mappings. The runtime verifier checks several
other isolation fields but omits these fields, so matching name, labels, memory
and ports do not establish that a container retains the reviewed isolation.
Prioritize rejecting capability grants, missing isolation controls and host
device access at the runtime authorization boundary. Review compatibility with
existing approved instances before implementing a stricter policy.

These tests demonstrate acceptance of unsafe Docker inspection metadata. They
do not demonstrate remote exploitation, successful host-device access by UID
1000, or a container escape. Supplying the altered configuration normally
requires administrator/Engine access or unsafe manual provisioning. Public
Discord callers do not gain a provisioning API from this finding. Seccomp
override rejection is a hardening expectation derived from minimum privileges;
the runbook does not define a complete seccomp-profile allowlist.

Three additional failures simulate the persistent volume name changing on the
second, pinned inspection during backup. `BackupWorker.run()` checks mount
identity before copying, then checks only clean stopped state after copying.
It emits `verified` despite the changed mount metadata. Rechecking the approved
mount tuple would fail closed on inconsistent inspection results. This is a
defensive consistency gap: Docker normally makes mounts immutable for the same
container ID, and this test does not establish a real Docker mount-swap attack.
Real replacement of the pinned container ID is rejected in the passing tests.

No fixes were applied to application code; all 18 failing assertions remain
active, without skips or TODO markers. Consequently `npm test` currently fails.

## Passing coverage

- Faithful restricted inspection remains accepted for every candidate.
- Reject privileged mode, management network attachment, host PID/shared
  container networking, Docker socket mounts and restart-policy drift.
- Reject wildcard IPv4/IPv6 binding when only loopback is approved, duplicate
  or missing bindings, TCP substituted for UDP, extra REST administration
  publication, missing memory limit, spoofed instance labels and renaming.
- Empty per-instance allowlists deny start, stop and status before any Engine
  access. A healthy Docker probe never promotes unverified game readiness.
- Same-game instances need distinct host UDP ports; separate ports coexist.
- Pinning rejects replacement container IDs.
- Backup refuses running, paused, restarting, created, removing, dead,
  nonzero-exit, OOM and missing-exit-code states without writing archives.
- Wrong persistent volume name, type or destination is refused. Post-copy
  running state and changed pinned identity fail without successful reporting.
- Wrong-instance restores and corrupted archives fail. Existing restored bytes
  survive refusal. Binary save bytes round-trip exactly. Hardlinked installation
  files fail closed and source bytes remain intact.
- Cross-game overlapping archive destinations are rejected.
- Compose candidates have no host namespaces, capability grants, device
  access, management routing or lifecycle hooks; publish only native UDP;
  use distinct external volume placeholders; bound process/log growth.
  Palworld's competing automatic lifecycle mechanisms remain disabled.

## Executed validation

| Command | Result |
| --- | --- |
| `node --test tests/phase7-adversarial.test.mjs tests/phase7-backup-boundaries.test.mjs tests/phase7-exposure.test.mjs` | 151 tests: 133 passed, 18 failed, zero skipped/cancelled/TODO |
| `npm test` | 877 tests: 859 passed, 18 failed, zero skipped/cancelled/TODO; all failures are the new assertions above |
| `npm run check:infrastructure` | All 11 checks passed, including Compose interpolation and missing-variable rejection for all three games |
| `git diff --check` | Passed for tracked changes; there are no tracked modifications |
| `git diff --no-index --check -- NUL <new-file>` for each of the five additions | Passed; Git emitted only LF-to-CRLF normalization warnings |

The full suite includes 726 pre-existing tests, all passing in this run. It
includes the original Phase 7 integration tests for Discord/controller HTTP,
lifecycle, monitoring, restart reservations and byte recovery. New tests use
actual verifier/worker/archive functions against mock Docker metadata and
unique temporary filesystem fixtures. Existing tests and CI were preserved.

Node 20.15.1 initially failed before loading tests with sandbox `EPERM` while
resolving `C:\Users\erwan`. The local commands above were then executed outside
that restriction. The initial loader failure is not counted as application
test evidence. Full TAP evidence is retained at:

```text
C:\Users\erwan\AppData\Local\Temp\atlas-phase7-full-3bfc503e-605c-45b7-9e05-76803e1f7784.log
C:\Users\erwan\AppData\Local\Temp\atlas-phase7-focused-bec3de3e-853e-40ef-8d3e-546f11a31ea9.log
```

## Preservation and limits

Initial state: `main` at `ada2f99`, no tracked/staged changes, 20 pre-existing
untracked files. `origin/main` was reported gone; current remote divergence
cannot be established from that reference. No fetch/integration was necessary.
Only four new test/helper files and this new report were added. No existing
files were edited, staged, committed or pushed.

Filesystem fixtures and evidence remain under unique OS temporary paths. The
worker's normal cleanup removes only its freshly generated restore-test data.
No production files, images, containers, volumes, firewall rules or host
services were changed. Compose checks render configuration only.

This finite suite is not exhaustive security certification. It does not prove
native UDP exposure, real signed Discord delivery, gameplay, rootless image
startup, actual shutdown/save consistency, Linux permissions, host isolation,
game restore compatibility or power-loss durability. Phase 7's live acceptance
gates remain required. V Rising rootless compatibility and Palworld installation
links remain specifically documented deployment risks. Proposed next work is
to review runtime isolation enforcement, then perform individually approved
isolated Linux acceptance for each game before production access.
