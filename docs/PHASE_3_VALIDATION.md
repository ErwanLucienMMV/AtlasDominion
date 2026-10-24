# Phase 3 validation

## Autocomplete and error formatting follow-up

The unchanged adversarial suite reproduced four failures (81 passed): overlapping registry pages emitted duplicate choices, and inherited error category names `constructor`, `__proto__` and `toString` returned non-string values from the formatter. Autocomplete now deduplicates emitted stable instance IDs before counting its 25-choice budget, preserving cursor-cycle, page and deadline limits. Error lookup now requires an own property and otherwise returns the existing sanitized fallback.

Overlap is relevant when pages change between requests or upstream pagination is inconsistent; a fixed registry does not ordinarily produce it. The formatter defect could suppress a deferred final reply, but the production controller client filters these codes to `DOCKER_UNAVAILABLE`. No public exploit, prototype pollution or authorization bypass was demonstrated.

Seven new regressions cover a fully populated distinct-choice budget across overlapping pages, actual final error delivery and pending-slot release for all three categories, and controller filtering for each category. The unchanged adversarial tests and new regressions pass together: **92 passed, zero failed or skipped**. The existing untracked review reports and tests were preserved without modification.

Final full `npm test`: **416 passed, zero failed, cancelled or skipped**, Node 20.15.1 on Windows. Full output: `C:/Users/erwan/AppData/Local/Temp/atlas-phase3-fix-full.log`; reproduction and targeted output use the adjacent `atlas-phase3-fix-baseline.log` and `atlas-phase3-fix-targeted.log`. `git diff --check` passed. Tests required the same Windows process permission described below. No deployment or push was performed.

Phase 3 implements the separate signed Discord HTTP service, generic commands and registry-backed selection. No production deployment, remote command registration, real Discord call, real Docker operation or game provisioning was performed.

## Evidence

- Final `npm test`: **324 passed, zero failed, cancelled or skipped**, Node 20.15.1 on Windows. Includes all pre-existing untracked acceptance tests and 18 new Phase 3 tests. Output: `C:/Users/erwan/AppData/Local/Temp/atlas-phase3-tests.log`.
- Tests run real Nest HTTP listeners and real controller-client HTTP transport on loopback. Game containers and Discord webhook delivery use mocks. Real stalled HTTP transport validates controller deadlines and the 1.8-second autocomplete budget.
- `node scripts/discord-command.mjs` successfully prints the generic guild-only command definition without network calls.
- `git diff --check` passed. Git emits Windows LF-to-CRLF normalization notices; no whitespace errors were reported.
- No dependencies, lockfile, existing tests, CI or infrastructure templates were removed or weakened. The existing Traefik route remains unchanged; the service uses its `/discord/interactions` path.

The first sandboxed Node run could not read a Windows parent directory (`EPERM`); the unchanged tests ran with the required process permission. An integration fixture initially omitted required policy flags and was corrected to preserve the schema. A new regression exposed stripped underscores in displayed error categories; the formatter now preserves them and the assertion remains intact.

## Security and live limitations

See the [configuration and security review](PHASE_3_DISCORD.md) and [acceptance matrix and live checklist](PHASE_3_ACCEPTANCE_TESTS.md). Signed raw-body verification precedes identity extraction. Global Discord authorization intersects controller global and instance checks. Tokens and personal identifiers remain ephemeral and are not logged. Input sizes, controller responses, request duration, autocomplete scanning, pending jobs, replay entries and user rate-limit buckets are bounded. Deferred replies and autocomplete have distinct acknowledgement paths.

Local acknowledgement tests establish that controller I/O does not delay command deferral; they do not establish real Discord or Internet timing. Real HTTPS, command registration, webhook connectivity, secret mounts, log review and deployment approval remain operator gates. Rate limiting, duplicate tracking and deferred work are single-process and not durable. Webhook failures have no durable delivery queue. Real game connectivity, graceful stop and persistence are Phase 4.

## Preservation and commits

All nine pre-existing untracked acceptance/test files remain untouched and excluded from Phase 3 commits. No push, merge, history rewrite or destructive operation was performed.

The first two milestone commits were mistakenly spaced 109 seconds apart, below the requested 120 seconds. They were preserved rather than rewriting history. The final milestone is guarded by checking the elapsed time since the previous commit before committing.
