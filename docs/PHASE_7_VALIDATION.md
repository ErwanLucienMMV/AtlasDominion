# Phase 7 validation — 2026-10-25

Implementation scope: independent V Rising, Project Zomboid and Palworld Compose candidates, matching registry examples, optional read-only backup mounts and job examples, and automated generic integration checks. No core controller, Discord or backup implementation changed. See [compatibility review and required live acceptance](PHASE_7_GAMES.md).

## Executed checks

- `npm test`: 725 tests passed, zero failures/skips. This run included the pre-existing untracked Phase 0–6 adversarial/documentation tests, preserved without edits. The backup-overlay assertion was added afterward and checked in the focused final run below.
- `node --test tests/phase7-configuration.test.mjs tests/phase7-integration.test.mjs`: final eight tests passed, zero failures/skips. Checks cover combined registry ownership/port conflicts, isolation and extra-port rejection, backup mount/config correspondence, Discord autocomplete and completion through an authenticated local HTTP controller, pinned mock Docker lifecycle, idempotency, restart reservations, unverified readiness, actual observer resource sampling with mock statistics, intentional-stop alert suppression, running/crashed backup refusal, isolated byte restore, no-overwrite restore and preserved source markers.
- `npm run check:infrastructure`: final eleven checks passed, including actual Compose v2 parsing/interpolation for all three new games and rejection of each omitted required operator variable. These commands only render configuration; they never pull/create/start containers.
- `node scripts/validate-registry.mjs infrastructure/games/minecraft/instance.example.json infrastructure/games/vrising/instance.example.json infrastructure/games/zomboid/instance.example.json infrastructure/games/palworld/instance.example.json`: all four manifests validated together.
- `git diff --check`: passed. Git reports its existing LF-to-CRLF normalization warnings on edited text files; no whitespace errors were reported.

Node initially failed before loading a test because the Windows sandbox denied parent-path resolution (`EPERM` on `C:\Users\erwan`). The same commands passed with the sandbox restriction lifted. Node 20 does not expand filename globs here, so focused tests use explicit file names. Early new-fixture failures identified a missing pre-created lock directory and an incorrect expectation for existing Discord error wording; fixtures were corrected while preserving the intended assertions. No pre-existing tests or CI were disabled or weakened.

## Acceptance still outstanding

No Docker game image was acquired or executed, no services/volumes were provisioned, and no deployment or external messaging occurred. Local tests use mock Engine state, synthetic save bytes and stubbed Discord webhook delivery. They do not establish signed real Discord delivery, native UDP reachability, actual gameplay, saved player/world consistency, image initialization permissions, Linux socket/volume permissions or real game recovery.

Each game still requires the runbook's recorded image/build compatibility, external gameplay, save/stop/start persistence, live monitoring and isolated restored-game acceptance. V Rising's upstream root assumptions make non-root startup a specific unresolved deployment blocker. Palworld installation symlinks may require a reviewed saves-only volume before its strict backup strategy is usable. Steam-downloaded binaries are not pinned by the image digest; V Rising/Zomboid startup updates need explicit operational review. These limitations are gates, not passing results.

Two implementation milestones are committed separately: configuration/compatibility runbook, followed by runtime/backup integration verification and validation evidence. Commits are spaced by at least two real minutes, with no fabricated timestamps. Existing untracked work remains outside these commits. Nothing is pushed.
