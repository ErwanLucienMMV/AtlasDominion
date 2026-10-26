import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerAccess } from '../apps/docker-controller/docker.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { ControllerClient } from '../apps/discord-api/controller.mjs';
import { DiscordService } from '../apps/discord-api/service.mjs';

export const actor = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: [] };
export const policy = { allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] };
export const fixture = JSON.parse(readFileSync(new URL('./fixtures/phase8/instance.json', import.meta.url)));

export function fleet(count = 1) {
  return Array.from({ length: count }, (_, i) => {
    const entry = structuredClone(fixture);
    if (count > 1) {
      entry.id = `nebula-${String(i).padStart(2, '0')}`;
      entry.displayName = `Synthetic server ${i}`;
      entry.container.name = `mock-${entry.id}`;
      entry.container.requiredLabels['io.atlasdominion.instance'] = entry.id;
      entry.container.publishedPorts[0].hostPort += i;
      entry.gameType = `synthetic-type-${i % 5}`;
    }
    Object.assign(entry.policy, structuredClone(policy));
    return entry;
  });
}

export async function harness(t, instances = fleet(), capacity = { memoryMiB: 4096, cpuUnits: 100 }) {
  const states = new Map(instances.map(entry => [entry.id, {
    Id: `pinned-${entry.id}`, Name: `/${entry.container.name}`,
    Config: { User: '1000:1000', Labels: structuredClone(entry.container.requiredLabels) },
    State: { Status: 'exited', ExitCode: 0, OOMKilled: false },
    Mounts: [{ Type: 'volume', Name: `world-${entry.id}`, Destination: '/world' }],
    NetworkSettings: { Networks: { [`atlas-game-${entry.id}`]: {} } },
    HostConfig: { NanoCpus: 2e9, PidsLimit: 1024, NetworkMode: `atlas-game-${entry.id}`, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' },
      Memory: entry.resources.hardMemoryMiB * 1048576,
      PortBindings: Object.fromEntries(entry.container.publishedPorts.map(p =>
        [`${p.containerPort}/${p.protocol}`, [{ HostIp: '127.0.0.1', HostPort: String(p.hostPort) }]])) }
  }]));
  const calls = [], failures = new Map(), gates = new Map(), audit = [];
  const docker = new DockerAccess({ getContainer: name => {
    const entry = instances.find(e => e.container.name === name || states.get(e.id).Id === name);
    assert.ok(entry, `Only pre-provisioned mock containers may be accessed: ${name}`);
    const data = states.get(entry.id);
    return {
      inspect: async () => {
        calls.push(['inspect', entry.id]);
        if (failures.has(entry.id)) throw failures.get(entry.id);
        return structuredClone(data);
      },
      start: async () => { assert.equal(name, data.Id); calls.push(['start', entry.id]); await gates.get(entry.id); data.State.Status = 'running'; },
      stop: async () => { assert.equal(name, data.Id); calls.push(['stop', entry.id]); data.State.Status = 'exited'; },
      stats: async () => {
        calls.push(['stats', entry.id]);
        if (failures.get(`stats:${entry.id}`)) throw new Error('Synthetic sample failure');
        return { memory_stats: { usage: 4096 }, cpu_stats: { cpu_usage: { total_usage: 2e9 } } };
      }
    };
  } }, ['127.0.0.1']);
  const service = new ControllerService({ instances, policy, capacity, docker, timeoutMs: 5000, stopTimeoutSeconds: 1,
    audit: { append: async event => audit.push(event) } });
  await service.reconcile();
  const secret = 'phase8-local-only-'.repeat(4), app = await createApplication(service, [secret]);
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const client = new ControllerClient({ url: await app.getUrl(), secret });
  const deliveries = [], discord = new DiscordService({ controller: client, applicationId: '323456789012345678', pollMs: 1,
    fetchImpl: async (_url, init) => { deliveries.push(JSON.parse(init.body)); return new Response('{}'); } });
  return { instances, states, calls, failures, gates, audit, docker, service, app, secret, client, discord, deliveries };
}

export async function settled(service) {
  const deadline = Date.now() + 5000;
  while (service.locks.size) { assert.ok(Date.now() < deadline, 'Mock lifecycle must settle'); await delay(2); }
}
