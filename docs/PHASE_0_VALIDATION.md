# Phase 0 validation record

## Delivered

- Versioned instance schema and a dependency-free, side-effect-free validator, plus explicit CLI validation of a complete candidate registry.
- Internal API data types, lifecycle/readiness/backup adapter capability boundaries and state/error semantics.
- Identity labels, private network topology, authentication/authorization rules, responsibility split and safe onboarding/removal checklist.
- Explicit deployment gates and resolution of the conflicting audit identity guidance in favor of SECURITY.md data minimization.

## Evidence

`npm test`: 19 tests passed on Node 20.15.1. Includes 50 same-game instances, 50 arbitrary game types, unknown instance, duplicate ID/container ownership, conflicting host ports, TCP/UDP coexistence, malformed IDs/ports/protocols, missing fields, unknown schema/adapters, label mismatch, forbidden commands/paths, invalid resources/allowlists and policy violations.

`npm run validate:registry -- tests/fixtures/instance.json`: passed. No Docker operations performed.

`git diff --check` and staged whitespace checks: passed. Git reports LF-to-CRLF conversion warnings under the local Windows configuration; no line-ending policy was changed.

Tests initially failed before loading application code because sandboxed Node could not resolve the workspace path (`EPERM` on the user directory). The approved run outside the sandbox passed. No test or CI requirement was removed or weakened.

## Limits and next phase

The schema evaluator deliberately implements only keywords used by the checked-in schema; it is not a general-purpose JSON Schema validator. No runtime loader or Docker identity enforcement is implemented yet. Phase 2 must validate all files before activation and enforce operation-time checks independently.

The `.d.ts` files define interfaces only. TypeScript compiler validation was not available because no compiler is installed; when setting up TypeScript tooling, run `tsc --noEmit --strict --lib es2022,dom --module nodenext --moduleResolution nodenext libs/contracts/index.d.ts libs/game-adapters/interfaces/index.d.ts`.

Remote branch inspection (`git ls-remote --heads origin`) failed both inside and outside the sandbox due to the local certificate chain. No remote state or divergence is asserted. No push was requested or performed.

No production host access, DNS verification, RAID/capacity measurements, Docker deployment, API endpoint, Discord integration, backup or live security test is included. The fixtures have no production allowlists. Approval of deployment settings remains outstanding as listed in the contract.

Next: Phase 1 infrastructure design/configuration after relevant host inventory and hostname/TLS decisions. Production changes still require separate operator approval.
