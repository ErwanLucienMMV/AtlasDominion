# Phase 9 runtime identity correction — 2026-10-26

The supplied [deep edge-case report](PHASE_9_DEEP_EDGE_CASES.md) is preserved as pre-correction evidence. Phase 9 already existed; this milestone corrects additional runtime drift checks rather than implementing a new phase.

## Reproduction and correction

The unchanged `phase9-runtime-drift` suite reproduced **11 passes and 10 failures**. The verifier accepted containers after CPU/PID ceilings disappeared, accepted extra game/shared network attachments, and accepted missing runtime user evidence. The end-to-end cases demonstrated simulated starts after drift; no real daemon or unauthenticated compromise was involved.

`verifyIdentity` now requires a positive safe-integer CPU ceiling (`NanoCpus`, or both `CpuQuota` and `CpuPeriod`), positive safe-integer `PidsLimit`, and explicit nonroot `Config.User`. Existing labels, memory, ports, namespace, privilege, socket and sensitive-mount restrictions remain in force. Finite CPU/PID ceilings do not certify measured sizing or equate CPU admission reservations with runtime CPU limits.

Network attachments must exactly equal the permitted set, and the explicit `HostConfig.NetworkMode` must name a member of that set. The default is the shipped `atlas-game-<stable-id>` convention. Optional protected manifest `container.allowedNetworks` permits reviewed alternative names or multiple intended networks. Registry validation rejects empty, duplicate, reserved management and default/shared network approvals. The verifier never infers trust from an arbitrary Engine attachment or game title.

The optional field preserves existing manifest validity. Existing runtime configurations using different network names must obtain explicit registry approval before activation. This repository correction changes no live container or network. Operator changes to provisioning remain separately reviewed.

Twelve tracked fixture files now provide complete valid identity evidence: explicit nonroot user, finite CPU/PID ceilings, approved primary network and matching attachments where those were missing. Existing test assertions remain unchanged; supplied adversarial suites and pre-existing untracked work remain untouched. Negative tests still mutate valid base snapshots to prove each rejection independently.

## Verification

- Supplied runtime suite after correction: **21 passed**, zero failures/skips.
- Combined runtime/policy/security/lifecycle and affected Phase 4–7/fix regressions: **316 passed**, zero failures/skips/cancellations/TODO, **18.51 seconds**. Log: `%TEMP%/atlas-p9-identity-complete.txt`.
- Twenty added policy tests cover quota/period CPU representation, invalid PID types/ranges, incomplete network/user evidence, approved custom network sets and forbidden registry approvals.

Reproduce with:

```sh
node --test tests/phase9-runtime-drift.test.mjs tests/phase9-identity-policy.test.mjs tests/controller-security.test.mjs tests/controller-lifecycle.test.mjs tests/controller-isolation-shutdown.test.mjs tests/phase4-integration.test.mjs tests/phase4-adversarial.test.mjs tests/phase5-adversarial.test.mjs tests/phase6-adversarial.test.mjs tests/phase7-configuration.test.mjs tests/phase7-integration.test.mjs tests/phase9-fix-regressions.test.mjs
```

Tests ran on Windows Node 20.15.1 with the existing approved sandbox exception for workspace-parent resolution. Runtime enforcement on Linux, named-user UID resolution, network reachability and measured production resource ceilings remain operator acceptance gates. No deployment, push, dependency change or CI weakening is performed.
