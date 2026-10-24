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

Node.js 20 or newer; no packages need installing.

```sh
npm test
npm run validate:registry -- tests/fixtures/instance.json
npm run check:infrastructure
```

`npm test` needs only Node. The separate infrastructure check also needs Docker Compose v2; it validates configuration without starting containers or requiring a running Docker daemon.

The fixture is illustrative, denies Discord access, and must not be deployed. Registry validation performs no Docker operations. Production identity checks, NestJS applications, adapters and backups belong to subsequent phases.

The six original root Markdown files are preserved and remain ignored by the existing `.gitignore`; this repository tracks the new implementation documentation under `docs/`.
