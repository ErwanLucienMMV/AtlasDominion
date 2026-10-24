# Phase 1 validation record

Validated on Windows with Node 20.15.1 and Docker Compose v2.35.1-desktop.1. No containers, networks, images, volumes, firewall rules or production services were created or changed.

## Evidence

- `npm test`: 85 passed, zero failures/skips/cancellations, approximately 61 seconds. Includes all 68 existing Phase 0 tests plus 17 new renderer/CLI tests. The two pre-existing untracked Phase 0 files were exercised unchanged and remain outside Phase 1 commits.
- `npm run check:infrastructure`: seven Compose validation checks passed. Both challenge modes, both log modes, private application wiring, independent game identity/network/data and required-variable failure are covered. No Docker daemon is needed.
- An initial combined discovery run also passed all 92 checks. Docker checks were then given a separate explicit entry point to preserve the existing dependency-free Node test command. No assertions or coverage were removed.
- Generated review edge and application/game templates passed `docker compose config`; `git diff --check` passed.
- Invalid renderer input and existing output paths reject safely; no pre-existing configuration or certificate data is overwritten.

The first sandboxed Node attempt failed before loading code (`EPERM` resolving the user directory). Approved execution outside the sandbox passed. The initial render lacked its parent `runtime` directory and safely refused; after creating that new ignored parent, rendering passed. The runbook explicitly requires an existing parent and a new child directory.

Initial sandboxed Docker inspection emitted an inaccessible Docker-config warning. Approved Compose checks passed. Git reports Windows LF-to-CRLF warnings; no line-ending settings were changed. Remote inspection failed due to a local TLS certificate-chain error, so no assertion about remote branch divergence is made and nothing was pushed.

## Limits

The Docker client is installed, but no Docker daemon is running. Compose normalization does not validate Traefik's runtime parser, issue certificates or prove live routing/network isolation. No actual hostname, DNS/port inventory, Linux host access or deployment approval was supplied. Public HTTPS, renewal, log samples, external probes, native game persistence and preservation of the live TCP 4242 workload therefore remain unexecuted acceptance gates. Follow [the live acceptance runbook](PHASE_1_INFRASTRUCTURE.md) on an approved test host before production rollout.

Application Compose is wiring for future implementations, not working NestJS services. No game image was selected or installed. No monitoring/backup implementation was added. Phase 1 configuration is delivered; live deployment acceptance remains pending. Next phase: implement the generic Docker controller with authentication, registry loading and operation-time enforcement.
