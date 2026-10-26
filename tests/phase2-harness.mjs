// Independent data from docs/PHASE_0_CONTRACTS.md and PHASE_2_CONTROLLER.md.
// No real Docker connection; only the documented inspect/start/stop capability.
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { DockerAccess } from '../apps/docker-controller/docker.mjs';
export const actor = { guildId: '111111111111111111', userId: '222222222222222222', roleIds: [] };
export const policy = () => ({ allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] });
export const request = (key = 'independent-key-0001', authorization = actor) => ({ authorization: structuredClone(authorization), idempotencyKey: key });
export function manifest(i = 0) {
  return {
    schemaVersion: 1, id: `edge-${i}`, displayName: `Independent game ${i}`, gameType: 'unknown-compatible-game',
    container: { name: `approved-${i}`, requiredLabels: { 'io.atlasdominion.managed': 'true', 'io.atlasdominion.instance': `edge-${i}` }, publishedPorts: [{ hostPort: 30000 + i, containerPort: 7777, protocol: 'udp' }] },
    adapter: { lifecycle: 'generic', readiness: 'unverified', stop: 'docker-stop', backup: 'stopped-volume' },
    resources: { admissionMemoryMiB: 100, admissionCpuUnits: 1, hardMemoryMiB: null },
    policy: { ...policy(), stopRequiresAdmin: false, allowAutoRestart: false },
  };
}
export function inspection(entry) {
  return { Id: `pinned-${entry.id}`, Name: `/${entry.container.name}`, Config: { User: '1000:1000', Labels: structuredClone(entry.container.requiredLabels) }, State: { Status: 'exited' },
    NetworkSettings: { Networks: { [`atlas-game-${entry.id}`]: {} } },
    HostConfig: { NanoCpus: 2e9, PidsLimit: 1024, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' }, Privileged: false, PublishAllPorts: false, NetworkMode: `atlas-game-${entry.id}`,
      PortBindings: { '7777/udp': [{ HostIp: '127.0.0.1', HostPort: String(entry.container.publishedPorts[0].hostPort) }] } } };
}
export function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
export async function until(predicate, timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('Timed out waiting for test condition'); await new Promise(r => setTimeout(r, 5)); }
}
export function harness(options = {}) {
  const instances = Array.from({ length: options.count ?? 2 }, (_, i) => manifest(i));
  const data = instances.map(inspection), calls = [], events = [];
  const hooks = { inspect: null, start: null, stop: null, audit: null };
  const docker = new DockerAccess({ getContainer(name) {
    return {
      async inspect() {
        calls.push(['inspect', name]);
        if (hooks.inspect) await hooks.inspect(name);
        const d = data.find(d => d && (d.Id === name || d.Name === `/${name}`));
        if (!d) throw { statusCode: 404 };
        return structuredClone(d);
      },
      async start() { calls.push(['start', name]); if (hooks.start) await hooks.start(name); data.find(d => d?.Id === name).State.Status = 'running'; },
      async stop(config) { calls.push(['stop', name, config]); if (hooks.stop) await hooks.stop(name); data.find(d => d?.Id === name).State.Status = 'exited'; },
    };
  } }, ['127.0.0.1']);
  const service = new ControllerService({ instances, docker, policy: policy(), capacity: options.capacity ?? { memoryMiB: 1000, cpuUnits: 10 },
    audit: { async append(e) { if (hooks.audit) await hooks.audit(e); events.push(structuredClone(e)); } }, timeoutMs: options.timeoutMs ?? 2000, stopTimeoutSeconds: 1,
    ...(options.maxOperations === undefined ? {} : { maxOperations: options.maxOperations }) });
  return { service, instances, data, calls, events, hooks };
}
