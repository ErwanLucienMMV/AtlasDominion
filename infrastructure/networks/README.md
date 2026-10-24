# Network ownership

After Linux-host inventory and explicit deployment approval, an administrator creates dedicated bridge networks once:

```sh
docker network create --driver bridge --internal atlas-proxy
docker network create --driver bridge --internal atlas-control
docker network create --driver bridge --internal atlas-monitoring
```

Inspect existing networks with these names first. Refuse to adopt a network unless its driver, internal flag, subnet and attached containers have been reviewed. Never delete or replace an existing network to resolve a collision. Choose non-overlapping subnets after examining host, VPN and existing Docker routes; defaults above let Docker allocate them only after that review.

Independent Compose projects refer to these networks as external, so project teardown does not own them. Traefik additionally has its own outbound bridge for ACME. Discord has a separate outbound bridge for Discord webhooks. Controller joins control and monitoring only; no host port, proxy or outbound network. Monitoring services will be delivered in Phase 5. Each game project owns a distinct native-traffic bridge and never joins these shared networks.

An internal network is not authentication or a full host firewall. Multi-homed services and published ports need runtime verification. Docker socket access remains host-administrative even with a read-only socket bind. Only the controller receives that socket. Application services here are wiring contracts for later phases, not working Phase 1 applications. Their file-secret, registry and port settings must be implemented and validated before starting them. Container stdout logging is disabled pending application log redaction; sanitized persistent audit is a later controller responsibility.
