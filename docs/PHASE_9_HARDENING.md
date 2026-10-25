# Phase 9 production hardening

This phase delivers repository safeguards and repeatable verification. It does not authorize deployment, daemon restarts, host reboots, firewall changes or restoration over existing data. Earlier live game acceptance gates still apply.

## Request and capacity safeguards

Both Nest HTTP applications limit active handlers to 32. Excess requests receive sanitized HTTP 429 responses. A slot remains owned until its handler settles, including after client disconnect. Discord deferred work separately retains its existing bounded job reservation and per-member rate limit. Unsigned traffic is rejected before command processing; no IP-based identity is persisted.

Node servers allow at most 128 simultaneous connections and 100 requests per socket, with 5-second header and keep-alive limits, a 10-second request-body deadline and 30-second socket inactivity timeout. These bound transport exposure; they do not cancel Docker work. Reverse proxy controls and container limits remain necessary against ingress floods.

The controller accepts at most `maxPendingRequests` queued/active admission requests (default 100), independently of retained operations (`maxOperations`, default 10000). Both must be positive safe integers. Queue saturation returns `RESOURCE_EXHAUSTED` before inspecting Docker or writing audit records. Existing atomic memory/CPU reservations, registry limits and per-instance exclusion remain mandatory. Configure admission budgets only after reserving measured capacity for the OS, existing TCP 4242 workload and infrastructure.

An execution inspection returning after timeout cannot begin a start or stop. In-flight mutations cannot be undone by a deadline: retain their instance lock until the underlying work settles, report timeout, and reconcile before accepting new work. Never clear a lock merely to make admission succeed.

## Milestone-one validation

`node --test tests/phase9-safeguards.test.mjs tests/controller-lifecycle.test.mjs tests/controller-http.test.mjs tests/discord-http.test.mjs`: 28 passed, zero failures/skips. The new checks exercise admission saturation/recovery, HTTP work ownership, transport configuration and late inspection for both start and stop. Existing ingress signature/authorization and lifecycle tests also pass.

The first sandboxed Node launch failed before test loading with Windows `EPERM` on the workspace parent. The same tests passed with a sandbox exception; no assertions were changed to accommodate this environment.

`npm test`: 1,026 passed, zero failures/skips/cancelled (85.74 seconds). Full output: `%TEMP%/atlas-phase9-m1-full.txt`. This includes the preserved untracked tests. `git diff --check` passed with existing LF-to-CRLF notices.

## Infrastructure and CI safeguards

Application, monitoring and generated edge templates now bound memory, CPU and process counts. Initial template memory ceilings are Discord 256 MiB, controller 512 MiB, Traefik 256 MiB, Prometheus 512 MiB, Grafana 256 MiB and Node Exporter 128 MiB. The independent backup worker retains its 256 MiB bound. These are reviewable starting values, not measured production sizing. Render and review overrides against measured baseline usage before deployment; admission capacity must exclude this infrastructure allocation. No container is recreated by changing a template in Git.

The controller remains only on control/monitoring networks, without published ports; the backup worker retains `network_mode: none`. Both socket mounts are host-administrative capabilities: `read_only` does not restrict Docker API verbs. Keep their images/configuration/operator access trusted. Discord, Traefik, games and Grafana have no socket access. Do not introduce a socket proxy or alter service boundaries without separate architectural review. Review image users and host socket-group permissions at deployment; templates cannot prove image runtime privilege.

`npm run check:production` renders all application/game/monitoring/backup Compose checks, including merged overrides, without pulling images or starting services. Existing `check:infrastructure` remains available. CI runs the full suite on Linux with Node 20 and 22, plus all Compose checks and Prometheus rule syntax/semantic tests. The alert fixture verifies intended stops stay quiet, unexpected exits alert, and daemon/resource/event-stream failures become visible. CI has read-only repository permissions and no deployment credentials or deployment steps. Hosted execution and branch-protection enforcement require remote/operator access; no push or protection changes are performed here.

`tests/phase9-infrastructure.test.mjs` and existing infrastructure suites: 20 passed. Local `promtool` is unavailable; CI installs it in its disposable runner. Run `promtool check rules infrastructure/monitoring/alerts.yml` and `promtool test rules tests/fixtures/phase9/alerts.test.yml` on a host with that tool before deployment. Configured checks are not evidence of an executed hosted run.

`npm run check:production`: 15 passed, zero failures/skips; Compose configuration only, with no daemon operations. Whitespace validation passed.
