# Phase 9 audit and archive corrections — 2026-10-26

The supplied [deep edge-case report](PHASE_9_DEEP_EDGE_CASES.md) is retained as historical evidence. Reproduction of its storage suite confirmed **13 passes and 5 failures**: two audit-tail failures, two manifest-link failures and the concurrent-release failure handled by the separate cleanup milestone. No supplied assertion was changed.

## Audit continuity

Replay accepts a complete final JSON record without a newline, but append previously concatenated the next record onto it. The next replay then failed. Append now examines and validates the final logical record using backward 4 KiB reads. A complete valid record receives a separator before the next appended record when its terminator is absent. Existing bytes remain unchanged. A malformed or invalid final record rejects append and retries without changing its evidence, with or without a terminal newline.

LF, CRLF and CR endings remain supported, as do serialized concurrent appends and clock rollback. The new regressions additionally cover a long UTF-8 legacy record crossing read boundaries, precise preservation of original bytes, ordering of subsequent queued writes and refusal of damaged-tail retries. This does not repair already concatenated or otherwise damaged history. Startup replay continues failing closed on it. One active writer and trusted filesystem ancestry remain required.

## Manifest metadata

Archive payload inventory already rejected links, but verification read `manifest.json` without applying that policy. Verification now requires a regular manifest with exactly one link. It opens the file with no-follow where the platform supports that flag, verifies the opened handle identifies the checked file, and checks its type/link count before and after reading. Restore uses the same verification before creating a destination. Existing hardlinked manifests remain untouched and refused.

These checks do not make mutable, untrusted archive storage authentic or eliminate every filesystem race in the wider inventory/copy path. Archive roots and ancestor directories remain trusted, and checksum verification is still integrity evidence rather than proof of origin.

## Validation

`node --test tests/phase9-storage-fix-regressions.test.mjs tests/phase9-storage-faults.test.mjs tests/controller-audit.test.mjs tests/phase9-recovery-adversarial.test.mjs tests/phase6-backup.test.mjs tests/phase6-recovery-regressions.test.mjs tests/phase7-backup-boundaries.test.mjs`: **136 passed**, zero failures/skips/cancellations/TODO, **3.23 seconds**. Log: `%TEMP%/atlas-phase9-storage-fix-validation.txt`. This includes all 18 supplied storage tests, ten added storage regressions and the concurrently delivered lock-release correction.

An earlier cross-feature focused run passed 55 and failed five existing identity-positive cases while the identity worker's snapshot updates were still in progress. The failures were `IDENTITY_MISMATCH` in `phase9-fix-regressions.test.mjs`; they were reported for coordinated validation rather than suppressed. Its log remains `%TEMP%/atlas-phase9-storage-fix-focused.txt`.

Tests used Windows Node 20.15.1 with the required sandbox exception for resolving the workspace parent. Whitespace verification passed with existing LF-to-CRLF normalization notices. No production archive, audit history or Docker resource was modified. Full-suite validation is coordinated separately; live filesystem failure, reboot and gameplay restoration remain operator gates.

Only `apps/docker-controller/audit.mjs`, `apps/backup-worker/archive.mjs`, the new storage regression file and this report belong to the initial storage worker's milestone. Its commit is coordinated at least two minutes from the other feature commits. Nothing is pushed or deployed.

## Forward compatibility correction

The coordinated full run after the initial correction passed **1,299 tests and failed one**: the preserved Phase 2 persistence test writes a complete, delimited operator metadata object before asking the writer to append sanitized audit events. The new final-record schema check blocked that existing append behavior. Its original bytes were preserved, but this was an application compatibility regression. The test and all existing assertions remain unchanged.

The writer now preserves a narrow distinction between append boundaries and trusted replay. A nonempty JSON object containing none of the five audit fields may remain opaque operator metadata only when already line-delimited. Append preserves its bytes and writes the next event separately. Replay still refuses that object as an audit record, so it never becomes inferred intent. An unterminated metadata object, malformed JSON, empty object, primitive/array or partial audit-shaped record still fails append. A complete unterminated audit record still requires the full schema before a separator is added.

Five additive tests cover LF/CRLF/CR metadata preservation, strict replay refusal, unterminated metadata refusal and incomplete audit-shaped metadata refusal. All ten first-milestone regressions remain enabled unchanged.

Focused compatibility validation: **150 passed**, zero failures/skips/cancellations/TODO, **2.73 seconds**, including all nine preserved Phase 2 persistence tests. Log: `%TEMP%/atlas-phase9-storage-compatibility-validation.txt`. Reproduce the earlier focused command with `tests/phase2-persistence-boundaries.test.mjs` added. This follow-up is a separate forward commit; the initial storage commit remains traceable.

Final coordinated `npm test`: **1,305 passed**, zero failures/skips/cancellations/TODO, **67.89 seconds**. Log: `%TEMP%/atlas-p9-deep-fix-complete.txt`. Production configuration checks: **15 passed**, **43.81 seconds**, log `%TEMP%/atlas-p9-deep-fix-production.txt`. The original 80 adversarial tests, child fixture and report retain their supplied hashes. These checks do not execute live recovery or production Docker mutations. Local `promtool` remains unavailable; its existing CI/operator checks and other live gates remain required.
