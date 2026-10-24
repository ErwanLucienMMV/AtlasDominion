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

## Milestone 3: acceptance and deployment runbook

Automated checks perform no deployment:

```sh
npm test
npm run check:infrastructure
git diff --check
```

The additional Compose checks require the Docker CLI with Compose v2, but not a running daemon. They render both ACME challenges and log modes, inspect normalized topology/ports/mounts, exercise separate game instances over TCP/UDP, and prove missing required settings reject configuration. Inputs and generated diagnostic files live in new OS temporary directories and are retained. The CLI tests prove rejected configuration does not leak input values and existing outputs are preserved. These checks validate configuration; they do not substitute for actual Traefik parsing or live isolation tests.

### Before asking to deploy

1. Record the read-only Linux inventory from OPERATIONS.md, current TCP 80/443/4242 owners, Docker networks/routes, baseline free capacity and existing service health. Confirm DNS A/AAAA records and chosen challenge reach this host. A stale AAAA can break ACME; do not change DNS/firewall without authorization.
2. Review the rendered files and exact image digest. Install/pull images only through a separately approved operator action. `pull_policy: never` deliberately fails if the image is unavailable. Rendered JSON/YAML is configuration, never a provisioning API.
3. Verify shared network names and internal flags. Obtain approval for network creation if absent; do not adopt unrelated networks. Review Docker-published-port firewall behavior independently of host firewall defaults.
4. Verify Linux permissions: output/state directories private, `state/acme.json` mode 0600. Review private backup of ACME keys, diagnostic logs and any proposed access-log retention. Keep generated state and settings outside Git (`runtime/` is ignored). ACME email is private configuration, not an application event.
5. Obtain explicit approval for the exact edge startup and port publications. Only then, on the approved host, run `docker compose -f <new-render-directory>/compose.json up -d --no-deps --no-build --pull never traefik`. This affects the new edge service only; if an existing `atlas-edge` project exists, review recreation consequences separately. Do not deploy applications with placeholder images or start any game.

### Live acceptance on an approved isolated test host

Use a reviewed disposable HTTP backend with network alias `atlas-discord-api`, listening on port 3000 on `atlas-proxy`, to test Phase 1 routing independently of the future Discord implementation. It must have no published port, socket, secret or host-data mount. Have it return a fixed marker on POST and expose received method/path plus a boolean for authorization-context-header presence for inspection; do not echo arbitrary headers/bodies or log requests. Provisioning this fixture needs its own reviewed command/image. Never publish a dummy interaction backend as a production Discord endpoint.

| Check | Required evidence |
|---|---|
| HTTP redirect | `curl -I http://<hostname>/discord/interactions` returns HTTPS Location, without following to a private service |
| HTTPS routing | POST to exact hostname and `/discord/interactions` reaches fixture; no ACME/route errors in reviewed diagnostics |
| TLS | Staging handshake works with explicitly untrusted staging CA handling; production `curl` succeeds **without** `-k`, hostname and chain valid; renewal/storage survive approved edge restart |
| Route exclusion | HTTPS GET on interaction path; POST on `/`, `/metrics`, `/v1/health`, `/v1/servers`, `/dashboard/`, `/discord/interactions/extra`; and unknown Host all return Traefik 404 |
| Trust header | Send `X-Atlas-Authorization-Context: forged`; backend confirms header absent |
| Body safety | Body larger than 16 KiB returns 413; accepted body bytes remain unchanged for future signature verification |
| No private publication | Inspect effective Docker bindings: no Controller, Prometheus, exporter or socket endpoint on host; probe approved target ports from an external client |
| Network boundaries | Inspect attachments and test reachability from a game-network fixture: no controller/control/monitoring reachability; inspect Traefik mounts and confirm no Docker socket/provider |
| Logs | Default mode creates no access log; optional sanitized mode includes only four allowed fields even for hostile URL/query/header/body inputs; no IPs/tokens/identifiers |
| Independent game lifecycle | Reviewed mock per-game project creates stopped; native TCP/UDP bypass proxy; data volume persists across authorized start/stop; edge lifecycle leaves it unaffected |
| Existing workload | Compare TCP 4242 availability and baseline service state before/after every approved action |

Use a real signed Discord backend only in Phase 3; invalid signatures must then return 401 rather than fixture success. Missing future backends can produce 502/503 and do not prove functional public routes. Grafana/metrics acceptance is deferred to Phase 5, real game persistence to Phase 4. Firewall rules, externally observed host isolation and Linux certificate permissions cannot be proved on a Windows development machine.

Rollback is a separately reviewed operation: stop only the new edge service if approved; preserve all generated configuration, ACME state, networks and data volumes. Never use destructive cleanup as rollback. Do not migrate or replace the existing reverse proxy or TCP 4242 service.

### Security review and remaining gates

File Provider replaces socket-based discovery. The public route cannot select container images, names, shell commands or management endpoints. No implicit game title dependencies exist. Each game keeps its own network/data/project, controller remains private, and Discord has no Docker socket. Application image pinning, file-secret interpretation, 32-byte service secret enforcement, runtime bearer authentication, registry enforcement and sanitized audit still require the implementations in Phases 2/3; these templates alone do not enforce them. Read-only socket mounting does not reduce Docker API privileges.

Phase 1 configuration is ready for operator review. Live acceptance remains gated on actual hostname, port inventory, image review, Linux host access and explicit deployment approval. No such evidence is fabricated here. Next implementation phase is the generic controller, without widening this phase into game, monitoring or backup deployment.
