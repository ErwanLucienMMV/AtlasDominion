# AtlasDominion

Self-hosted Discord management of administrator-provisioned Docker game servers.

Phase 0 defines contracts only. No services, game containers or infrastructure are deployed.

Phase 1 adds independent Compose templates and a validated Traefik File Provider renderer. See the [infrastructure setup and acceptance runbook](docs/PHASE_1_INFRASTRUCTURE.md). Host inventory, real DNS/TLS and deployment approval remain required; application services belong to later phases.

[Phase 1 validation evidence and remaining live checks](docs/PHASE_1_VALIDATION.md).

- [Architecture, API, security and adapter contracts](docs/PHASE_0_CONTRACTS.md)
- [Safe onboarding](docs/ADDING_A_GAME.md)
- [Validation evidence and limitations](docs/PHASE_0_VALIDATION.md)
- [Instance JSON Schema](libs/server-registry/instance.schema.json)
- [API types](libs/contracts/index.d.ts)
- [Adapter interfaces](libs/game-adapters/interfaces/index.d.ts)

Phase 2 adds the authenticated NestJS/Dockerode controller, lifecycle locks, resource admission and sanitized audit logging. See the [controller configuration and security runbook](docs/PHASE_2_CONTROLLER.md) and [validation evidence](docs/PHASE_2_VALIDATION.md). No live deployment has been performed.

Phase 3 adds signed Discord HTTP interactions, guild/user/role authorization, dynamic server commands, autocomplete, pagination and deferred private replies. See the [Discord configuration and security runbook](docs/PHASE_3_DISCORD.md) and [Phase 3 validation](docs/PHASE_3_VALIDATION.md).

Phase 4 adds a separate Minecraft Java Edition stack with a persistent external world volume, matching deny-by-default registry example and signed lifecycle integration tests. See the [Minecraft setup and live acceptance runbook](docs/PHASE_4_MINECRAFT.md) and [validation evidence](docs/PHASE_4_VALIDATION.md). Live deployment, graceful saving, gameplay and persistence checks remain operator gates.

Phase 5 adds authenticated instance metrics, Docker event watching, periodic reconciliation, audit-based desired-state recovery, private Prometheus/Node Exporter/Grafana configuration, generic dashboards and lifecycle/host alert rules. See the [monitoring setup and acceptance runbook](docs/PHASE_5_MONITORING.md) and [validation evidence](docs/PHASE_5_VALIDATION.md). Deployment and real-host acceptance remain operator gates; backups belong to Phase 6.

Node.js 20 or newer; install the pinned application dependencies with `npm ci`.

Phase 6 adds an independent scheduled stopped-volume backup worker, persistent lifecycle exclusion, SHA-256 archives, isolated restoration verification and opt-in retention. See the [backup and recovery runbook](docs/PHASE_6_BACKUP.md) and [validation evidence](docs/PHASE_6_VALIDATION.md). Real Minecraft recovery and deployment remain operator gates.

```sh
npm test
npm run validate:registry -- tests/fixtures/instance.json
npm run check:infrastructure
```

`npm test` needs Node and the installed dependencies. The separate infrastructure check also needs Docker Compose v2; it validates configuration without starting containers or requiring a running Docker daemon.

The fixture is illustrative, denies Discord access, and must not be deployed. Registry validation performs no Docker operations. Controller tests use mock Docker containers. Live Discord deployment, real game validation, monitoring and backups remain operator-gated work for subsequent phases.

The six original root Markdown files are preserved and remain ignored by the existing `.gitignore`; this repository tracks the new implementation documentation under `docs/`.
