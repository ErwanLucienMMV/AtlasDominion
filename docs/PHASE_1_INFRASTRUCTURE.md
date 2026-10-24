# Phase 1 infrastructure

Phase 1 supplies reviewable infrastructure configuration, not authorization to modify the production host. Existing TCP 4242 services remain outside these projects. No game, monitoring service or application is deployed by this phase.

## Milestone 1: independent stack foundations

- `infrastructure/networks/README.md`: separately owned shared networks, private control and monitoring, explicit outbound paths.
- `infrastructure/applications/compose.json`: future API/controller wiring. No published ports; only controller mounts the socket. Images, registry and secret files must be operator supplied. This is a contract for Phases 2/3, not an implemented runtime.
- `infrastructure/games/compose.template.json`: administrator-only single-instance project, exact labels, no automatic restart/pull, explicit native port, resource limits and external persistent volume. Copy to a new reviewed file per instance; adapt image-specific environment, user, data mounts, ports and graceful shutdown. Do not assume every image supports these defaults. No initial or future game is deployed by the template.

Compose files use JSON, a YAML subset accepted by Docker Compose, so configuration is also parseable without installing packages. Required interpolation variables deliberately have no production defaults. Network membership is isolation plumbing; authenticated application APIs remain required.

Before game creation, compare rendered ports/labels/name with the validated registry and existing host listeners. Reserve TCP 4242 and existing workloads. Create the approved persistent volume separately, then use the selected service only: `docker compose -f <reviewed-game-file> create --no-deps --pull never game`. This creates a stopped container; do not use `up` for onboarding. Never use `down -v`, automatic pulls, or whole-stack recreation. Named external volumes survive project lifecycle; consistency, backup and restore still require later-phase implementation.

## Milestone 2: File Provider edge

Copy `infrastructure/traefik/settings.example.json` to a new private settings file. Replace the hostname/email, review the exact Traefik patch version (prefer a verified digest), and explicitly choose `http-01` or `tls-alpn-01`. The example image is a version pin, not a security certification or automatic update policy. DNS-01 is not implemented; if neither inbound challenge is possible, resolve the deployment design before proceeding. No DuckDNS API token is needed by these inbound challenges.

Create the parent `runtime` directory once, then render into a **new** child directory:

```sh
npm run render:infrastructure -- /private/settings.json runtime/phase1-staging
docker compose -f runtime/phase1-staging/compose.json config --quiet
node --test tests/infrastructure.test.mjs
```

The renderer makes no Docker calls and refuses existing output directories, including symlinks. A missing parent fails safely; a failed partial render is retained for inspection, so retry with another new directory. JSON documents with `.yml` extensions are valid YAML consumed by Traefik. Directory-mounted dynamic configuration supports File Provider watching without socket access. Only exact signed-interaction ingress is routed; signature validation belongs to Phase 3. The private authorization-context header is removed before forwarding, and requests are bounded to 16 KiB. The API must preserve the raw body and independently enforce its limits. Grafana routing is deliberately deferred until authenticated Grafana exists in Phase 5.

HTTP redirects to HTTPS; TLS minimum is 1.2. HTTP-01 requires public TCP 80; TLS-ALPN-01 requires public TCP 443. Both require correct DNS and reviewed port ownership; the edge publishes both web ports for redirects. ACME defaults to staging in the example. Staging certificates are intentionally untrusted. Switch to an explicitly reviewed production setting only after staging acceptance, rendering to a new directory with independent certificate state. Never overwrite, truncate or copy a live ACME file as a troubleshooting shortcut. On Linux, the renderer creates private directories and mode-0600 ACME storage; Windows permissions do not prove Linux permissions. Verify them on the actual host before startup. Certificate state must persist and be backed up securely across restarts.

Access logs default to absent/disabled under the Phase 0 contract. Optional `sanitized` logging is an operator-reviewed change: default-drop fields and headers, retain only UTC timestamp, duration, downstream status and a fixed router name. No URL, query, IP, user, request header or body is allowed. Logs go to a private bind directory. Before enabling on production, set an approved host rotation/retention policy and inspect hostile-request samples; no automatic deletion/retention job is installed. Traefik diagnostic logs use ERROR level and bounded Docker local logging (two 1 MiB files); error messages still need review for identifiers before deployment. Do not enable debug logs to investigate live credentials.

References: [File Provider directory mounts](https://doc.traefik.io/traefik/reference/install-configuration/providers/others/file/), [ACME challenge and storage requirements](https://doc.traefik.io/traefik/reference/install-configuration/tls/certificate-resolvers/acme/), [access-log default-drop fields](https://doc.traefik.io/traefik/v3.0/observability/access-logs/).
