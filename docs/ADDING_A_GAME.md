# Administrator-controlled onboarding

This is a review checklist, not permission to deploy. Existing root documentation remains the baseline; the Phase 0 contract defines executable manifest conventions.

1. Verify dedicated-server distribution, license, Linux/image compatibility, pinned version/digest and graceful shutdown requirements. Do not deploy future-game examples from PLAN.md.
2. Measure available host capacity after OS, monitoring, backups and the existing port 4242 application. Reserve headroom; document admission budgets separately from Docker limits.
3. Review a separate Compose service with persistent named volumes, explicit native TCP/UDP mappings, minimal privileges, isolated networks and `restart: 'no'`. Check host and registry port conflicts; preserve existing services.
4. Choose reviewed lifecycle/readiness/stop/backup capabilities. Generic compatibility does not guarantee safe saving; use unverified readiness until a real probe exists.
5. Set both `io.atlasdominion` labels from the stable ID. Use a distinct container name. Do not mount the Docker socket or join control/proxy networks.
6. Obtain deployment approval, then pre-create only the selected service without dependencies/start. A reviewed `docker compose create --no-deps <service>` may be used after the pinned image is available; inspect the actual Compose plan first. Never run stack-wide recreation commands.
7. Write one schema-valid JSON manifest with explicit allowlists. Validate the entire candidate set: `npm run validate:registry -- <file1.json> <file2.json>`. Empty lists deny control. Fixture budgets and IDs are not production defaults.
8. Verify exact Docker identity, labels, ports, addresses, limits, volume persistence and stopped state. Activate the registry through a reviewed read-only mount and controller restart. This does not create resources.
9. In later runtime phases, test authorized start/status/stop, unauthorized/unknown rejection, readiness, external gameplay and persistence. Confirm the existing service is unaffected.
10. Configure consistent stopped-volume backup with approved worker source/destination references. Test archive verification and isolated restore before relying on it; never overwrite the live world for a test.
11. Validate generic metric discovery, dashboard selection and Discord pagination/autocomplete. Expose the instance only after operator acceptance.

Removal is separately approved: deny new operations, wait for active work, safely stop/save, retain tested backups, then remove the registry entry through review. Container/volume deletion is a distinct destructive operation requiring explicit approval. Do not delete data as part of unregistering an instance.
