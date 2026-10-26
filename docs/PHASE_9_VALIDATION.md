# Phase 9 validation — 2026-10-25

Repository scope: production safeguards, CI configuration, synthetic failure/recovery tests and operational documentation. No live production certification is claimed. See [safeguards](PHASE_9_HARDENING.md) and the [recovery/acceptance runbook](RECOVERY.md).

## Requirement mapping

| Phase 9 requirement | Implementation and evidence | Remaining live gate |
|---|---|---|
| Controller privileges and network isolation | Existing exact identity/isolation checks retained; only controller/worker socket mounts; private management networks, no management ports; `phase9-infrastructure`, `phase7-security-regressions` and exposure suites | Inspect actual image users, socket groups and internal bridge membership; socket access remains host-administrative |
| Internal authentication | Existing constant-time bearer validation and independent policy/identity checks retained; controller HTTP/security suites; separate metrics credential wiring | Provision protected distinct tokens; verify coordinated rotation and actual external isolation |
| Public Discord audit | Existing signature/raw-body/timestamp, guild/member/instance policy, strict command and idempotency checks retained; existing Discord HTTP/adversarial suites | Real HTTPS/Discord negative probes, unauthorized traffic and receiver delivery |
| Resource/capacity safeguards | Bounded HTTP handlers/connections/body times, bounded admission queue, positive safe operation limits, late-mutation guard, infrastructure memory/CPU/PID ceilings; `phase9-safeguards` and `phase9-infrastructure` | Measure host baseline and set safe budgets/limits while preserving TCP 4242 |
| Published native game ports | Registry conflict validation and exact Docker protocol/port/address matching retained; registry, identity, Phase 4/7 configuration/security and Compose checks | External TCP/UDP reachability/firewall checks and game clients |
| Logging and retention | Sanitized durable audits retained; Docker local rotation/disabled logs, Prometheus time/size limits and opt-in verified backup retention retained; audit, backup and infrastructure suites | Approve audit/proxy/archive storage policy; no automatic audit pruning/checkpoint |
| Docker daemon failure | New outage/recovery drill plus late-inspection timeout tests; no fabricated success or automatic restart | Approved real daemon interruption and transport behavior |
| Host reboot behavior | New controller instance reopens real audit files, reconstructs intent and observes simulated stopped games; persistent backup lock remains owned | Approved Linux host reboot, boot ordering/storage/Engine live-restore verification |
| Backup restoration | New dependency-free offline recovery CLI shares verified archive restoration; synthetic child-process CLI drill checks bytes, existing-output preservation, instance mismatch and damaged evidence | Real isolated game restore, graceful saving, ownership and gameplay checks |
| Monitoring/alerting | Existing generic metrics/dashboard and event/reconciliation/sampling alerts retained; new Prometheus semantic fixture covers intended stops, crashes and controller/event/resource failure; CI invokes promtool | Local promtool and hosted CI not executed here; alert delivery, backup-log receiver, public endpoint/TLS probes need operator acceptance |
| Disaster recovery | `RECOVERY.md` gives evidence, diagnosis, daemon/reboot, secret rotation, isolated restore and activation procedure | Select RTO/RPO and record real drill times; on-host-only backup cannot protect against complete host loss |
| Automated CI/integration | New read-only GitHub Actions workflow runs `npm ci`/full tests on Node 20 and 22, all Compose checks and Prometheus rule checks; existing test infrastructure preserved | Push/hosted execution and branch protection are not performed/changed |

The acceptance criteria retain configuration-driven onboarding/removal, approved-instance-only lifecycle access, no arbitrary Discord provisioning and independent infrastructure. Existing unknown-game/50-instance tests continue passing. No additional real game, adapter, service dependency or deployment is introduced.

## Executed validation

- First milestone focused run: **28 passed**, zero failures/skips (new safeguard tests plus existing lifecycle and controller/Discord HTTP checks).
- First milestone full `npm test`: **1,026 passed**, zero failures/skips/cancelled/TODO, 85.74 seconds. Log: `%TEMP%/atlas-phase9-m1-full.txt`.
- Infrastructure/resource focused run: **20 passed**, zero failures/skips (new Phase 9 checks plus existing infrastructure and monitoring configuration suites).
- `npm run check:production`: **15 passed**, zero failures/skips, 46.08 seconds. These are Docker Compose configuration renders only; no daemon mutation, image pulls or deployment.
- Recovery focused run: **4 passed**, zero failures/skips. Uses mock Engine calls, new controller objects, real temporary audit/lock files and synthetic archive data; CLI is exercised as a child process.
- Final `npm test`: **1,032 passed**, zero failures/skips/cancelled/TODO, 107.51 seconds. Log: `%TEMP%/atlas-phase9-final-full.txt`. Includes all **1,021** baseline tests and **11** new Phase 9 checks, including preserved pre-existing untracked tests.
- `git diff --check` and staged whitespace checks passed. Git emits existing LF-to-CRLF normalization notices.

Windows sandbox Node initially failed with `EPERM` resolving the workspace parent before test loading. Local tests/Compose and authorized Git commits ran with sandbox exceptions. No verification requirement was disabled or weakened. Prometheus `promtool` is unavailable locally; its exact reproduction commands are in `RECOVERY.md` and CI. No hosted CI run, real network probe, image build, daemon interruption, host reboot or gameplay restoration was performed.

## Delivery and preservation

Three milestones: request/admission safety, infrastructure/CI, then recovery tests/tooling and documentation. Commits use actual creation times at least 120 seconds apart, guarded before subsequent commits; no timestamp fabrication. Existing untracked Phase 0–6 reports/tests are preserved unchanged and excluded from commits. The configured `origin/main` reference was already reported as gone; no remote integration is attempted. Nothing is pushed.

Phase 9 repository work is delivered. Production acceptance remains conditional on the live gates above and unresolved gates from earlier game phases. Next work is an operator-reviewed Linux deployment/acceptance exercise; off-host backup is separately scoped.

## Corrective review

The subsequently supplied [adversarial report](PHASE_9_ADVERSARIAL_VALIDATION.md) reproduced 13 failures across seven issue classes. See [corrective validation](PHASE_9_FIX_VALIDATION.md) for the causes, fixes and subsequent results. The original validation above remains historical evidence; it does not supersede those findings or the remaining live acceptance gates.

## Feature-worker follow-up — 2026-10-26

Phase 9 implementation and its earlier corrective commits were already present
at the start of this review. Three feature workers reviewed the requirements,
added regression coverage and corrected three additional boundaries:

- [Security and isolation review](PHASE_9_SECURITY_REVIEW.md): sensitive bind
  parent paths with trailing separators now fail identity checks; existing
  isolation, authentication and approved-port boundaries remain validated.
- [Capacity and ingress review](PHASE_9_CAPACITY_REVIEW.md): preflight now checks
  elapsed monotonic time before and after awaiting dependencies, preventing
  overdue promise resolutions from admitting a new lifecycle mutation.
- [Recovery and monitoring review](PHASE_9_RECOVERY_REVIEW.md): reconciliation
  and reconnect timers reject invalid or overflowing millisecond values;
  recovery and degraded-monitoring behavior retain their regression coverage.

Final coordinated verification on Windows Node 20.15.1:

- `npm test`: **1,184 passed**, zero failures/skips/cancellations/TODO,
  **49.77 seconds**. Log: `%TEMP%/atlas-phase9-final-worker-validation.txt`.
- `npm run check:production`: **15 passed**, zero failures/skips,
  **27.16 seconds**. Log: `%TEMP%/atlas-phase9-current-production.txt`.
  These are configuration renders; no Docker resources were changed.
- `git diff --check`: passed with existing LF-to-CRLF normalization notices.

The Windows sandbox required approved exceptions for Node workspace imports and
Compose configuration access. Node's mock-timer tests emitted their experimental
API warning; no warning was suppressed. Local `promtool` remains unavailable.
Hosted CI, real daemon/reboot/restore drills, alert delivery and live game
acceptance were not executed; their existing operator gates remain required.

Each feature worker creates its own milestone commit, coordinated at least two
minutes apart using actual creation times. Pre-existing untracked Phase 0–6
reports and tests remain unchanged and excluded from those commits. No history
is rewritten and nothing is pushed or deployed.
