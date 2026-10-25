# Phase 4 validation

## Runtime isolation and abnormal shutdown correction

The unchanged adversarial suite reproduced **50 passing and 10 failing tests**: six absent runtime isolation safeguards and four abnormal stop outcomes incorrectly marked completed. Reproduction output: `C:/Users/erwan/AppData/Local/Temp/atlas-phase4-reproduce.log`.

`docker.mjs` now rejects explicit root/default-root users, host/container-shared namespaces, reserved management networks, Docker socket mounts and sensitive host system bind mounts on every inspection. Both logical and deployed `atlas-*` management network names are covered. Ordinary reviewed data binds and named volumes remain usable. These generic restrictions supplement image/provisioning review; they do not provide exact per-instance mount/network allowlists or resolve arbitrary named users to UIDs.

`service.mjs` now rejects abnormal exit codes, OOM kills, dead containers and unexpected post-stop states with the existing sanitized `OPERATION_CONFLICT` category. Failed operations retain a null result and failed audit outcome; neither replay nor a fresh stop converts an abnormal exit into success. Created containers retain idempotent stop behavior, but cannot masquerade as a successful executed stop. Clean termination is still insufficient evidence of world-save integrity. Live log and gameplay persistence checks remain required.

Validation after correction:

- Focused unchanged adversarial/security/lifecycle/integration tests: **76 passed**, zero failed/skipped/cancelled. Log: `C:/Users/erwan/AppData/Local/Temp/atlas-phase4-fix-targeted.log`.
- Full `npm test`: **504 passed**, zero failed/skipped/cancelled, including all 478 existing tests and 26 new regressions. Log: `C:/Users/erwan/AppData/Local/Temp/atlas-phase4-safeguards-full.log`.
- All **8 Compose checks passed**. Log: `C:/Users/erwan/AppData/Local/Temp/atlas-phase4-safeguards-compose.log`.
- `git diff --check` passed. Node/Compose checks required the same Windows process permission described below. No test, CI or dependency configuration was weakened or removed.

The existing untracked adversarial report and tests remain untouched and outside this correction's commit. New tracked regressions cover additional root identity forms, actual deployed management network names, namespace sharing, read-only/path-normalized dangerous mounts, approved data mounts, clean termination, failed audit outcomes, replay behavior and fresh abnormal-stop rejection. No deployment, container mutation, push or history rewrite was performed.

Status: implementation and local validation complete; real-world Minecraft acceptance remains pending. No image was pulled, container provisioned, world modified, firewall changed or deployment performed.

## Delivered

- Independent Minecraft Java Edition Compose definition with fixed instance/container identity, native TCP 25565, external `/data` volume, explicit version/license/image/resource inputs, non-root execution, bounded local logs and no automatic restart.
- Schema-valid registry example using generic lifecycle, Docker stop, unverified readiness and stopped-volume backup declaration. All checked-in Discord allowlists are empty.
- Signed Discord HTTP integration test through both real Nest applications and authenticated controller transport into `DockerAccess`, with a mock Engine and mock webhook. Covers list/status/start/stop, replay, idempotent operations, exact pinned container ID, 90-second stop argument, controller reconstruction/reconciliation, unknown instance and unauthorized caller rejection. No Minecraft logic was added to application code.
- Read-only Compose validation and a [deployment/security/live acceptance runbook](PHASE_4_MINECRAFT.md).

## Executed evidence

Validated on Windows, Node 20.15.1, Docker Compose v2.35.1-desktop.1:

| Check | Result |
|---|---|
| `npm test` | **418 passed**, zero failed/cancelled/skipped; includes all pre-existing untracked tests |
| `node --test infrastructure/checks/compose.check.mjs` | **8 passed**, zero failed/cancelled/skipped; no Docker daemon operations |
| `node scripts/validate-registry.mjs infrastructure/games/minecraft/instance.example.json` | Validated one instance |
| `git diff --check` | Passed; Git reports ordinary LF-to-CRLF normalization notices |

Full test output: `C:/Users/erwan/AppData/Local/Temp/atlas-phase4-tests.log`. Compose output: `C:/Users/erwan/AppData/Local/Temp/atlas-phase4-compose.log`. The Compose image digest and Minecraft release in tests are configuration fixtures only; they do not represent an acquired or validated deployment image.

The initial sandboxed Node invocation failed on Windows parent-directory traversal (`EPERM`). Tests then ran with the required process permission. Git index updates also required process permission. The first Compose run exposed a new test assumption: this CLI serializes `mem_limit` as a string. Numeric normalization retains the exact byte-count assertion; the corrected full Compose suite passes. Existing tests and verification requirements were preserved.

## Remaining acceptance and risks

Real Dockerode/Engine communication, selected image compatibility, non-root volume ownership, EULA acceptance, actual Discord delivery, gameplay connectivity, graceful world saving and persistence across game restarts require the approved host and real client. No local mock result proves those properties. Follow the runbook and record each live outcome before production acceptance.

Controller `stopTimeoutSeconds` must exceed the image's save window; its explicit Dockerode timeout overrides Compose's grace period. Set the overall operation deadline longer still. Readiness is deliberately unverified. Backups and monitoring remain later phases. Local game logs can contain player information and need operator-approved access and retention.

## Preservation

The twelve pre-existing untracked documentation/test files were left untouched and excluded from Phase 4 commits. No dependencies, lockfiles, application handlers or controller business logic changed. No existing functionality, test or CI requirement was removed. Commits are local and forward-only, with an elapsed-time guard enforcing at least 120 seconds between milestone commits. No push or merge was performed.

Next planned implementation: Phase 5 monitoring and lifecycle events, after the relevant deployment gates are resolved.
