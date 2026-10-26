# AtlasDominion

AtlasDominion lets authorized Discord members list, inspect, start and stop administrator-provisioned Docker game servers. You provision containers and approve their configuration; Discord operates only instances in a validated registry.

This guide covers a Linux Docker host. The repository supplies application source, Compose templates, monitoring and a backup worker. **It does not include Dockerfiles or published application images.** Supply reviewed application images before deployment. Validate selected game images, graceful saving and real gameplay on an isolated instance before using production worlds.

## Deployment overview

1. [Prepare the host](#1-prepare-the-host) and review images.
2. [Configure applications](#2-configure-the-applications), credentials and authorization.
3. [Prepare networks and storage](#3-prepare-networks-and-storage).
4. [Configure HTTPS](#4-configure-https) and [start the platform](#5-start-the-platform).
5. [Connect Discord](#6-connect-discord) and [add game servers](#7-add-a-game-server).
6. Optionally [add web applications](#8-add-a-web-application), [monitoring](#9-set-up-monitoring) and [backups](#10-set-up-backups-and-restore).

The commands that create resources or start services are deployment steps for your reviewed host. Inspect existing resources first; they are not permission to replace an existing proxy, application or data volume.

## 1. Prepare the host

Install Git, Node.js 20 or newer, npm, Docker Engine and Docker Compose v2. Commands below run from the repository root in a Linux shell.

```sh
git clone https://github.com/ErwanLucienMMV/AtlasDominion.git
cd AtlasDominion
npm ci
npm test
npm run check:production
```

Tests use simulated Docker interfaces. Production checks render Compose configurations without starting containers; they do not prove live isolation, image compatibility or recovery.

Inventory the host before choosing capacity or ports:

```sh
ss -lntup
docker ps --format 'table {{.Names}}\t{{.Ports}}'
docker network ls
docker volume ls
free -h
df -hT
lsblk -o NAME,SIZE,FSTYPE,TYPE,MOUNTPOINTS
cat /proc/mdstat
```

Preserve existing services, including any workload on TCP 4242. Reserve RAM/CPU/disk for the OS, existing applications, monitoring and backups before budgeting games. Check port 80/443 owners before deploying Traefik; an existing proxy requires a reviewed coexistence or migration plan.

Choose DNS hostnames and check their A and AAAA records. HTTP-01 certificates require public TCP 80; TLS-ALPN-01 requires public TCP 443. The edge publishes both ports for HTTPS and redirects. Native game ports bypass Traefik and need their own exposure review.

## 2. Configure the applications

Keep private deployment files outside Git, for example:

```text
/etc/atlas/
  deploy.env
  controller.json
  discord.json
  applications.override.json
  registry/                 # one JSON manifest per instance, nothing else
  secrets/
    controller-token
    metrics-token
    grafana-password
```

Create new files without replacing existing configuration. Restrict permissions while allowing the selected container users to read their mounts. Generate distinct high-entropy credentials: controller and metrics tokens must each contain at least 32 bytes of token text, for example 64 random hexadecimal characters. Never put secret values in command arguments, logs or Git.

### Supply application images

Build and review images containing this repository and its pinned production dependencies. The controller image must run `node apps/docker-controller/main.mjs`; the Discord image must run `node apps/discord-api/main.mjs`, from the repository directory. The application Compose template supplies neither commands nor a working directory, so configure them in your images or an override. Use an explicit nonroot user, give only the controller the required Docker socket group access, and verify writable audit storage.

Acquire all approved application, infrastructure and game images explicitly before startup. Templates use `pull_policy: never`; missing local images fail instead of downloading. Use exact version pins, preferably reviewed digests, for the host architecture.

### Configure the controller

Create `/etc/atlas/controller.json` with this shape, replacing illustrative IDs, bindings and budgets:

```json
{
  "policy": {
    "allowedDiscordGuilds": ["111111111111111111"],
    "allowedDiscordUsers": ["222222222222222222"],
    "allowedDiscordRoles": []
  },
  "bindingAddresses": ["127.0.0.1"],
  "capacity": { "memoryMiB": 8192, "cpuUnits": 2 },
  "timeoutMs": 120000,
  "stopTimeoutSeconds": 90,
  "auditDirectory": "/audit"
}
```

Choose capacity from measured available resources. Loopback bindings suit local tests; use explicitly reviewed reachable addresses for players. Bindings must match Docker's exact `HostIp` values. Run one controller per registry/audit directory: locks and capacity reservations are not distributed. Keep audit data persistent and approve a disk budget and archival policy.

### Configure Discord

Create an application in the Discord Developer Portal. Put its application ID, Ed25519 public key and approved membership policy in `/etc/atlas/discord.json`:

```json
{
  "applicationId": "333333333333333333",
  "publicKey": "REPLACE_WITH_APPLICATION_PUBLIC_KEY_64_HEX_CHARACTERS",
  "policy": {
    "allowedDiscordGuilds": ["111111111111111111"],
    "allowedDiscordUsers": ["222222222222222222"],
    "allowedDiscordRoles": []
  }
}
```

Replace every placeholder. Authorization requires an allowed guild and an allowed user or role. Discord, controller and instance policies must all allow the request; empty instance allowlists deny access. Authorized members can both start and stop by default. HTTP interaction handling needs no Gateway connection or bot token.

### Set environment and mounts

Create `/etc/atlas/deploy.env` with actual image references and absolute paths:

```dotenv
DISCORD_API_IMAGE=your-reviewed-discord-image:exact-version
CONTROLLER_IMAGE=your-reviewed-controller-image:exact-version
REGISTRY_DIRECTORY=/etc/atlas/registry
CONTROLLER_SECRET_FILE=/etc/atlas/secrets/controller-token
CONTROLLER_CONFIG_FILE=/etc/atlas/controller.json
METRICS_SECRET_FILE=/etc/atlas/secrets/metrics-token
CONTROLLER_AUDIT_VOLUME=atlas-controller-audit
```

The base template lacks Discord's policy mount. Create `/etc/atlas/applications.override.json`:

```json
{
  "services": {
    "discord-api": {
      "environment": { "DISCORD_CONFIG_FILE": "/etc/atlas/discord.json" },
      "volumes": [{
        "type": "bind",
        "source": "/etc/atlas/discord.json",
        "target": "/etc/atlas/discord.json",
        "read_only": true,
        "bind": { "create_host_path": false }
      }]
    }
  }
}
```

Use the existing monitoring controller override to mount controller configuration, the persistent audit volume and separate metrics credential, even if you start monitoring later. Use absolute operator paths: relative paths in overrides resolve against the first Compose file. Detailed options are in the [controller guide](docs/PHASE_2_CONTROLLER.md) and [Discord guide](docs/PHASE_3_DISCORD.md).

## 3. Prepare networks and storage

Inspect existing resources with the proposed names first. Once names, subnets and ownership are approved, create the shared internal bridge networks and new audit volume:

```sh
docker network create --driver bridge --internal atlas-proxy
docker network create --driver bridge --internal atlas-control
docker network create --driver bridge --internal atlas-monitoring
docker volume create atlas-controller-audit
```

Do not adopt or replace unknown resources. Prepare audit volume permissions for the controller user. Give each world and monitoring database its own approved external volume; prepare ownership on new volumes for the selected image users. Avoid recursive ownership changes on existing data.

The controller has no published port and joins only control/monitoring networks. Discord joins proxy/control plus outbound networking. Games use separate networks. A read-only Docker socket mount still grants host-administrative API access; only the controller and separately reviewed backup worker receive it. See [network ownership](infrastructure/networks/README.md).

## 4. Configure HTTPS

Copy the [Traefik settings example](infrastructure/traefik/settings.example.json) into a new private file such as `/etc/atlas/traefik-staging.json`. Set the hostname, ACME email, supported challenge and reviewed image. Keep `certificateAuthority: "staging"` for initial testing.

```sh
mkdir -p runtime
npm run render:infrastructure -- /etc/atlas/traefik-staging.json runtime/edge-staging
docker compose -f runtime/edge-staging/compose.json config --quiet
```

The renderer requires an existing parent and a **new** output directory. It refuses existing destinations and preserves partial failures; retry using a new directory. Generated `dynamic/routes.yml` routes only `POST /discord/interactions` to `atlas-discord-api:3000`. Traefik uses File Provider with no Docker socket; access logs default to disabled.

Verify private directory permissions and mode 0600 on generated `state/acme.json`. Preserve certificate state across restarts and back it up securely. Staging certificates are intentionally untrusted. After staging acceptance, create reviewed settings with `certificateAuthority: "production"` and render a new directory, such as `runtime/edge-production`. Switching the existing edge to it changes the same Compose project: review that change and preserve previous certificate state. See the [HTTPS runbook](docs/PHASE_1_INFRASTRUCTURE.md).

## 5. Start the platform

Prepare and validate your instance registry using the onboarding steps below. Review the complete application configuration:

```sh
docker compose --env-file /etc/atlas/deploy.env \
  -f infrastructure/applications/compose.json \
  -f infrastructure/monitoring/controller.override.json \
  -f /etc/atlas/applications.override.json config --quiet
```

After approving startup, start only the selected services:

```sh
docker compose --env-file /etc/atlas/deploy.env \
  -f infrastructure/applications/compose.json \
  -f infrastructure/monitoring/controller.override.json \
  -f /etc/atlas/applications.override.json \
  up -d --no-deps --no-build --pull never docker-controller discord-api

docker compose -f runtime/edge-staging/compose.json \
  up -d --no-deps --no-build --pull never traefik
```

For production TLS, use the reviewed production render directory. These commands can recreate an existing selected service when configuration changes; inspect that change first. Keep the same full override chain for later application operations. They do not start games.

Verify authenticated controller `GET /v1/health` privately, using a protected client that reads the token from its secret file. Check successful reconciliation, writable audit storage, HTTPS routing and continued availability of existing workloads. Verify management/exporter ports are inaccessible externally. Do not publish a controller port for diagnostics.

## 6. Connect Discord

Generate the generic slash-command definition:

```sh
node scripts/discord-command.mjs
```

The script prints JSON; it does not register commands. Inspect current registrations, then register `/server` through your approved Discord application/guild workflow without replacing unrelated commands. Set the Developer Portal Interactions Endpoint URL to `https://YOUR_HOST/discord/interactions` after production HTTPS works. Verify Discord's signed PING succeeds and invalid signatures are rejected. Keep the host clock synchronized.

| Command | Purpose |
|---|---|
| `/server list [cursor]` | List authorized instances with pagination |
| `/server status instance` | Show Docker, desired and readiness states |
| `/server start instance` | Request a start and follow its operation |
| `/server stop instance` | Request a graceful stop |

Replies are private. Autocomplete comes from the registry without per-game command updates. Accepted work is not completed work, and Docker `running` is not proof a game is ready for players.

## 7. Add a game server

### Choose a definition

| Game | Compose and registry example | Setup guide |
|---|---|---|
| Minecraft Java | [Compose](infrastructure/games/minecraft/compose.json), [manifest](infrastructure/games/minecraft/instance.example.json) | [Minecraft](docs/PHASE_4_MINECRAFT.md) |
| V Rising | [Compose](infrastructure/games/vrising/compose.json), [manifest](infrastructure/games/vrising/instance.example.json) | [Additional games](docs/PHASE_7_GAMES.md) |
| Project Zomboid | [Compose](infrastructure/games/zomboid/compose.json), [manifest](infrastructure/games/zomboid/instance.example.json) | [Additional games](docs/PHASE_7_GAMES.md) |
| Palworld | [Compose](infrastructure/games/palworld/compose.json), [manifest](infrastructure/games/palworld/instance.example.json) | [Additional games](docs/PHASE_7_GAMES.md) |

For another compatible game, adapt the [generic Compose template](infrastructure/games/compose.template.json) and [instance schema](libs/server-registry/instance.schema.json). Existing generic capabilities need no controller or Discord changes. Custom readiness/save behavior may need an adapter. Verify Linux/image/nonroot compatibility; V Rising requires particular compatibility review.

### Provision and register

1. Choose a unique stable instance ID, container name, Compose project, volume and unused native TCP/UDP ports. A second instance of one game needs its own identity and resources.
2. Review image digest, game version, license, nonroot user, graceful shutdown and measured RAM/CPU/PID limits. Set `restart: "no"`, matching identity labels and an isolated network. The default approved network is `atlas-game-<instance-id>`; reviewed alternatives belong in `container.allowedNetworks`. Never attach games to management networks or mount the Docker socket.
3. Create a protected game environment file with all required Compose variables. Pre-create the approved external data volume and prepare ownership. The Minecraft setup guide lists image, version, EULA, heap, hard memory/CPU, bind-address and volume settings.
4. Review the resolved configuration, then create only the stopped service. For Minecraft:

   ```sh
   docker compose --env-file /etc/atlas/minecraft.env \
     -f infrastructure/games/minecraft/compose.json config --quiet
   docker compose --env-file /etc/atlas/minecraft.env \
     -f infrastructure/games/minecraft/compose.json \
     create --no-deps --pull never minecraft
   ```

5. Prepare a candidate registry directory with one JSON manifest per instance. Adapt the example's identity, exact ports, budgets and guild/user/role allowlists. Empty example lists deny everyone. Validate **all** candidate manifests together to detect duplicate identities and ports:

   ```sh
   npm run validate:registry -- /etc/atlas/registry-candidate/*.json
   ```

6. Inspect the stopped container. Its labels/name, exact port protocols/addresses, networks, nonroot user, finite CPU/PID ceilings, hard memory limit and volume must match the approved configuration. The controller rejects drift and never repairs/recreates containers.
7. Activate the reviewed registry through the read-only mount and an approved controller restart/recreation using the full application override chain. Registry loading happens at startup. If selecting a new directory, update `REGISTRY_DIRECTORY` and apply the mount change; a plain restart does not change mounts.
8. Test authorized and unauthorized Discord calls, start/status/stop, external gameplay, graceful saving and persistence after restarting the same game container. Confirm dashboard discovery and isolated backup recovery before relying on the instance.

For Minecraft, align controller stop timeouts with the image save window: Dockerode's explicit timeout overrides Compose's grace period. Sample readiness is `unverified` until a supported probe is configured. Follow the [complete onboarding/removal checklist](docs/ADDING_A_GAME.md).

To retire an instance, deny new operations, wait for operations/backups, stop/save safely and retain tested backups. Remove its registry entry through review. Deleting the container or world volume is a separate destructive action.

## 8. Add a web application

An HTTP application, such as a portfolio, can share Traefik without joining the game registry. Adding a web route does not enable Discord lifecycle control for it.

1. Provision it in a separate reviewed Compose project with a pinned image, resource limits, appropriate persistence and no host-published HTTP port. For example, save this as `/etc/atlas/portfolio.compose.json` and set `PORTFOLIO_IMAGE` to your locally available pinned image in `/etc/atlas/portfolio.env`. The image must run as an explicit nonroot user and listen on port 8080. Adapt storage and limits to the application:

   ```json
   {
     "name": "atlas-portfolio",
     "services": {
       "portfolio": {
         "image": "${PORTFOLIO_IMAGE:?Set reviewed pinned portfolio image}",
         "pull_policy": "never",
         "restart": "unless-stopped",
         "mem_limit": "256m",
         "cpus": "0.5",
         "pids_limit": 128,
         "cap_drop": ["ALL"],
         "security_opt": ["no-new-privileges:true"],
         "networks": { "proxy": { "aliases": ["atlas-portfolio"] } }
       }
     },
     "networks": {
       "proxy": { "external": true, "name": "atlas-proxy" }
     }
   }
   ```

   Only the frontend joins `atlas-proxy`. Keep databases/private dependencies on separate networks. The shared proxy network is internal; add a separate reviewed egress network only if this application needs outbound access. The example deliberately publishes no host port.
2. Point an approved hostname at the host. Ensure the app listens on its container interface and internal port, for example 8080.
3. Add a new uniquely named file such as `portfolio.yml` to the **active** edge directory's `dynamic/` directory. Replace the hostname, alias and port in this example; preserve existing route files:

   ```json
   {
     "http": {
       "routers": {
         "portfolio": {
           "rule": "Host(`portfolio.example.com`)",
           "entryPoints": ["websecure"],
           "service": "portfolio",
           "tls": { "certResolver": "letsencrypt", "options": "default" }
         }
       },
       "services": {
         "portfolio": {
           "loadBalancer": {
             "servers": [{ "url": "http://atlas-portfolio:8080" }]
           }
         }
       }
     }
   }
   ```

4. Validate the application configuration, review/apply startup and route changes, then verify HTTPS, intended paths and any required authentication:

   ```sh
   docker compose --env-file /etc/atlas/portfolio.env \
     -f /etc/atlas/portfolio.compose.json config --quiet
   docker compose --env-file /etc/atlas/portfolio.env \
     -f /etc/atlas/portfolio.compose.json \
     up -d --no-deps --no-build --pull never portfolio
   ```

   File Provider watches the mounted dynamic directory; no Docker socket/discovery or controller code change is needed. JSON is valid YAML for route files. Keep your additional routes in the deployment configuration backup when rendering a later edge directory.

Use distinct router/service names across files. Preserve the exact Discord route and security middleware. Never route the controller, Prometheus, exporters or Docker API publicly. Administrative applications need authentication; HTTPS alone does not restrict access. Grafana has a [dedicated route example](infrastructure/monitoring/grafana-route.example.json).

## 9. Set up monitoring

The [monitoring stack](infrastructure/monitoring/compose.json) provides private Prometheus, Node Exporter and authenticated Grafana. Generic dashboards discover registered instances automatically.

Add these reviewed values to the protected environment file:

- `PROMETHEUS_IMAGE`, `GRAFANA_IMAGE`, `NODE_EXPORTER_IMAGE`: locally available pinned images.
- `PROMETHEUS_DATA_VOLUME`, `GRAFANA_DATA_VOLUME`: pre-created external volumes, prepared for UID 65534 and UID 472 respectively.
- `METRICS_RETENTION`, `METRICS_RETENTION_SIZE`: approved storage time/size bounds.
- `GRAFANA_ADMIN_USER`, `GRAFANA_PASSWORD_FILE`: non-default admin name and unique protected password file.
- `GRAFANA_ROOT_URL`: approved HTTPS origin. `METRICS_SECRET_FILE` must match the separate controller scrape credential configured above.

Review Node Exporter's read-only host root mount and host PID visibility. Then validate and start selected services:

```sh
docker compose --env-file /etc/atlas/deploy.env \
  -f infrastructure/monitoring/compose.json config --quiet
docker compose --env-file /etc/atlas/deploy.env \
  -f infrastructure/monitoring/compose.json \
  up -d --no-deps --no-build --pull never prometheus grafana node-exporter
```

Adapt the Grafana route example to its dedicated hostname and add it to the active dynamic directory. Verify login, disabled anonymous access, healthy private scrape targets and populated dashboards. Rules evaluate alerts, but **external notification delivery is not configured**. Connect and test an approved receiver before relying on unattended alerts. See [monitoring setup and acceptance](docs/PHASE_5_MONITORING.md).

## 10. Set up backups and restore

The independent worker supports `stopped-volume` backups: SHA-256 archive verification and isolated byte restoration. It never stops or starts a game; running or uncleanly exited instances fail the attempt.

1. Adapt the [settings example](infrastructure/backup/settings.example.json) and [worker Compose file](infrastructure/backup/compose.json). Set exact volume/source/container paths, bindings, archive capacity, schedule and retention. The base worker mounts Minecraft data; other instances need additional read-only source mounts and jobs, illustrated by the [additional-game override](infrastructure/backup/phase7.override.json).
2. Set controller `backupLockDirectory: "/locks"` and add `infrastructure/backup/controller.override.json` to the **complete application override chain**. Controller and worker must mount the same pre-created host lock directory with permissions for both users. Apply and verify controller coordination before enabling the worker.
3. Supply `BACKUP_IMAGE`, `BACKUP_UID`, `BACKUP_GID`, `DOCKER_SOCKET_GID`, `BACKUP_CONFIG_FILE`, `BACKUP_DIRECTORY`, `BACKUP_LOCK_DIRECTORY`, `REGISTRY_DIRECTORY` and required game-volume variables in protected configuration. Review socket privileges, source readability and writable archive/lock directories. The image needs the repository working directory and pinned dependencies.
4. Validate `docker compose --env-file /etc/atlas/deploy.env -f infrastructure/backup/compose.json config --quiet`, then approve starting only `backup-worker` using `up -d --no-deps --no-build --pull never`. Include any additional worker overrides in both commands.
5. Stop/save a game gracefully, inspect a successful `verified` worker outcome and test isolated gameplay recovery. Retention deletion defaults off; enabling it approves that job's deletion policy separately.

Verify an archive offline into a fresh, absent destination:

```sh
node scripts/verify-recovery.mjs minecraft-survival \
  /approved/archives/minecraft-survival/ARCHIVE_ID \
  /approved/new-recovery-drill
```

This does not activate restored data or overwrite a live world. Review ownership and test the recorded image/game version in an isolated container before an approved production restoration. Persistent locks do not expire; investigate owners and outstanding work before authorizing removal. On-host archives cannot protect against total host/disk loss; off-host export is not implemented. See [backup procedures](docs/PHASE_6_BACKUP.md) and [disaster recovery](docs/RECOVERY.md).

## 11. Updates and troubleshooting

Record current image digests/configuration, save games safely, verify backups and inspect proposed changes before updating. Acquire pinned images explicitly and apply only reviewed selected services with complete override chains. Preserve previous configuration and data for a separately reviewed rollback. No automatic image/game updates or provisioning are implemented. Avoid stack-wide teardown, pruning or volume deletion.

| Symptom | Check |
|---|---|
| Compose rejects configuration | Required variables, absolute paths, existing external networks/volumes and readable secret files; run `config --quiet` |
| Application fails at startup | Image command/workdir/user, protected policy JSON, secret length, mount permissions and dependencies |
| Discord endpoint validation fails | DNS A/AAAA, production TLS, exact POST route, application public key and host clock |
| Instance missing or denied | Active registry, all three intersecting policies, controller reload and instance allowlists |
| Game identity rejected | Exact labels/name, ports/bindings, networks, nonroot user, memory/CPU/PID limits and approved mounts |
| Controller unready | Docker availability, audit writes, active operations/locks and reconciliation; a timeout does not cancel work |
| HTTPS returns 502/503 | Backend started, correct network alias/port, proxy membership and listening interface |
| No metrics | Separate token, private network, scrape target health and reconciliation/sampling status |
| Backup fails | Clean stopped state, volume identity, free space, source/archive permissions and shared lock ownership |

Applications minimize logs; controller decisions use sanitized audit files and backup outcomes use bounded worker logs. Preserve incomplete archives and failure evidence. Secrets are loaded at process startup: file replacement alone does not rotate credentials; coordinate approved restarts and verify old-token rejection. Running games continue independently of the API/controller. After daemon recovery or host reboot, inspect actual states before new lifecycle requests; games use restart policy `no`.

Before declaring deployment accepted, record real HTTPS/Discord checks, native game-port tests, private endpoint isolation, graceful save/persistence, monitoring/alert delivery, isolated restore and continued availability of existing services. Repository validation and remaining live gates are documented in [production safeguards](docs/PHASE_9_HARDENING.md), [validation results](docs/PHASE_9_VALIDATION.md) and the [recovery runbook](docs/RECOVERY.md).
