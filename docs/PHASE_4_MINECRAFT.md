# Phase 4 — Minecraft integration

The first game uses the existing generic lifecycle controller and unchanged Discord commands. `infrastructure/games/minecraft/compose.json` provisions one predefined Java Edition Vanilla server; `instance.example.json` supplies its matching registry manifest. No game has been deployed by this change. Live acceptance remains required.

## Operator configuration

Use a protected, untracked environment file outside the registry directory and pass it with `docker compose --env-file <protected-file> -f infrastructure/games/minecraft/compose.json config`. Do not commit rendered configuration or player data.

| Variable | Required review |
|---|---|
| `MINECRAFT_IMAGE` | Locally available, reviewed `itzg/minecraft-server@sha256:<digest>` for the host architecture and selected Java version; no floating tag |
| `MINECRAFT_VERSION` | Exact compatible Minecraft release, never `LATEST` or `SNAPSHOT` |
| `MINECRAFT_EULA` | Set `TRUE` only after the administrator accepts the Minecraft EULA |
| `MINECRAFT_HEAP` | Example `4G`; leave native/JVM headroom beneath the container limit |
| `MINECRAFT_MEMORY_LIMIT` | Example `6144m`, exactly matching registry `hardMemoryMiB: 6144`; measure host capacity first |
| `MINECRAFT_CPU_LIMIT` | Example `2`; review against admission capacity and other workloads |
| `MINECRAFT_BIND_ADDRESS` | Explicit approved host address; loopback for local checks, reviewed reachable address for players |
| `MINECRAFT_DATA_VOLUME` | Unique pre-created external named volume, writable by UID/GID `1000:1000` |

Examples are illustrative budgets, not measured production settings. Compose requires nonempty values but does not validate image digests, EULA acceptance, release channels or capacity. Review the rendered configuration. Do not accept arbitrary values from Discord.

The image stores worlds and configuration under [`/data`](https://docker-minecraft-server.readthedocs.io/en/latest/). An empty volume must be prepared for UID/GID 1000 before first start; do not recursively change ownership of existing data. The fixed non-root user avoids granting startup ownership-changing capabilities. Verify compatibility with the selected image digest on an isolated test volume. Online authentication remains enabled. The image generates an RCON password; port 25575 is never published. RCON remains internal to the isolated game network and supports the image's shutdown wrapper. No socket or control/proxy network is mounted.

The [shutdown wrapper](https://docker-minecraft-server.readthedocs.io/en/latest/configuration/misc-options/) gets a 60-second save window (`STOP_DURATION`), with no announcement delay. Compose allows 90 seconds. Configure controller `stopTimeoutSeconds: 90` and `timeoutMs: 120000` or a measured larger pair: **Dockerode's explicit stop timeout overrides Compose's grace setting**. A larger world may need longer values at all three layers. A timed-out operation does not prove that Docker stopped working. Never force-kill to make an acceptance check pass.

## Approved provisioning workflow

1. Follow [onboarding](ADDING_A_GAME.md): record Linux host inventory, port 25565/TCP availability, disk/RAM/CPU headroom, existing port 4242 workload health, image digest, exact server/client version and license decision. Obtain deployment approval before pulling images, creating resources or starting services. No firewall changes are implied.
2. Review the resolved Compose configuration. Acquire only the approved image. Prepare a new, uniquely named external volume with reviewed ownership; never reuse an unknown world. Retain the selected image digest and version alongside the private deployment record.
3. After approval, run the selected stack's `docker compose --env-file <protected-file> -f infrastructure/games/minecraft/compose.json create --no-deps minecraft`. This pre-creates a stopped container; do not use stack-wide `up`, recreation, teardown or volume deletion commands. A pre-existing container/name collision requires investigation and separate approval.
4. Inspect the container by name and record its immutable ID. Confirm labels, restart `no`, exact native TCP mapping and binding address, memory limit, volume name/mount, non-root user and isolated network. Configure the controller's `bindingAddresses` to include only approved bindings. The controller never provisions containers.
5. Copy the example manifest into a separate candidate registry directory. Set measured resource values and reviewed guild/user/role allowlists; the checked-in example denies everyone. Validate the complete candidate registry with `npm run validate:registry -- <all-manifest-files>`. Do not place Compose files or other JSON in the active registry directory. Review global Discord and controller policies as well as instance policy.
6. Mount the candidate registry read-only and activate through an approved controller restart. Set stop/operation timeouts as above. Preserve independent application stacks. Register the existing generic `/server` command if not already registered; adding Minecraft needs no command definition changes.
7. Execute the acceptance checklist below and retain private, redacted evidence. Do not grant general player access until live checks pass.

## Live acceptance checklist

Record date, host, image digest, Minecraft/client version, container ID, volume name, operator and pass/fail for each check. These are unexecuted gates, not reported successes.

1. Use a real authorized guild interaction: `/server list`, autocomplete and `/server status minecraft-survival` identify the stopped instance. Unauthorized users cannot list/control it; an unknown ID is rejected without Docker mutation.
2. `/server start minecraft-survival` acknowledges privately and completes through the authenticated controller. Inspect Docker status and audit outcome. Repeat start and confirm idempotency. Docker `running` alone is insufficient: readiness remains `unverified` in this manifest.
3. Wait for the game startup log, then connect with a matching authenticated Java Edition client from the intended external network at `<approved-host>:25565`. A successful TCP connection alone does not establish gameplay. Join, move and place a distinctive marker; record coordinates, inventory and a screenshot privately.
4. `/server stop minecraft-survival` completes. Review bounded local container logs for save/shutdown completion, inspect exit code and `OOMKilled`, and confirm no forced termination (especially exit 137). Confirm the client disconnects and the game port closes. Stop again and confirm `already_stopped`. Investigate nonzero exits rather than accepting them automatically.
5. Start the **same container** through Discord. Rejoin and verify marker, inventory and world/configuration persistence. Record unchanged container ID and named volume. Do not recreate the container or delete any data for this test.
6. With the server running, restart only the controller through the approved process. Confirm status/reservation reconciliation, then stop/start through Discord again. Confirm existing application health and independent stacks remain unaffected.
7. Stop/save before any backup procedure. Phase 6 implements the worker; `stopped-volume` currently declares the selected strategy only. Do not claim backup protection until archive and isolated restore checks exist.

## Security, limitations and next phase

Native game traffic bypasses Traefik. Only 25565/TCP is published; no RCON/query port, Docker socket, privileged mode or automatic restart is enabled. Game logs use bounded local rotation (three 10 MiB files) and may contain player identifiers/IPs: restrict Docker/host access and approve retention before production. Application audit remains sanitized. Named volumes survive stops/restarts; this does not replace backups.

The controller contains no Minecraft branches or arbitrary exec/provisioning operation. Other compatible games and multiple instances remain registry/Compose configuration changes, following the existing onboarding workflow. This concrete stack has fixed identity and port: a second instance needs its own reviewed project, container name, labels, native host port, volume and manifest. Do not reuse the example identity twice.

Runtime identity verification now rejects explicit root/default-root execution, host or container-shared namespaces, reserved management networks, Docker socket mounts and sensitive host system binds. This supplements deployment review; it does not establish exact per-instance mount/network/user ownership. Existing containers violating these restrictions fail identity verification and require separately reviewed provisioning corrections. The controller never modifies their configuration automatically.

Stops ending in a reported nonzero exit, OOM kill, `dead` or an unexpected state fail with sanitized `OPERATION_CONFLICT`; they do not emit completed audit records. A subsequent fresh stop cannot relabel an abnormal exit as `already_stopped`. An exit-zero stop can complete but still does not certify world-save integrity. Keep the live log and persistence gates above.

Local tests use a mock Engine and mock Discord webhook delivery. They cannot establish real Dockerode/Engine compatibility, image execution, graceful world saving, external Discord delivery, gameplay or world persistence. Phase 5 adds monitoring, Docker events and reconciliation; Phase 6 adds backups. Neither is silently introduced here.
