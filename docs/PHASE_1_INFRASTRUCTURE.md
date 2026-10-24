# Phase 1 infrastructure

Phase 1 supplies reviewable infrastructure configuration, not authorization to modify the production host. Existing TCP 4242 services remain outside these projects. No game, monitoring service or application is deployed by this phase.

## Milestone 1: independent stack foundations

- `infrastructure/networks/README.md`: separately owned shared networks, private control and monitoring, explicit outbound paths.
- `infrastructure/applications/compose.json`: future API/controller wiring. No published ports; only controller mounts the socket. Images, registry and secret files must be operator supplied. This is a contract for Phases 2/3, not an implemented runtime.
- `infrastructure/games/compose.template.json`: administrator-only single-instance project, exact labels, no automatic restart/pull, explicit native port, resource limits and external persistent volume. Copy to a new reviewed file per instance; adapt image-specific environment, user, data mounts, ports and graceful shutdown. Do not assume every image supports these defaults. No initial or future game is deployed by the template.

Compose files use JSON, a YAML subset accepted by Docker Compose, so configuration is also parseable without installing packages. Required interpolation variables deliberately have no production defaults. Network membership is isolation plumbing; authenticated application APIs remain required.

Before game creation, compare rendered ports/labels/name with the validated registry and existing host listeners. Reserve TCP 4242 and existing workloads. Create the approved persistent volume separately, then use the selected service only: `docker compose -f <reviewed-game-file> create --no-deps --pull never game`. This creates a stopped container; do not use `up` for onboarding. Never use `down -v`, automatic pulls, or whole-stack recreation. Named external volumes survive project lifecycle; consistency, backup and restore still require later-phase implementation.
