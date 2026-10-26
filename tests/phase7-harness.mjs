import { readFileSync } from 'node:fs';
import { DockerAccess } from '../apps/docker-controller/docker.mjs';

export const games = ['vrising', 'zomboid', 'palworld'];
export const actor = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: [] };
export const policy = { allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] };
export function fixture(game) {
  const read = file => JSON.parse(readFileSync(new URL(`../infrastructure/games/${game}/${file}`, import.meta.url)));
  const entry = read('instance.example.json'), stack = read('compose.json'), service = stack.services[game];
  const data = { Id: `approved-${game}`, Name: `/${entry.container.name}`,
    Config: { User: service.user, Labels: structuredClone(service.labels) },
    State: { Status: 'exited', ExitCode: 0, OOMKilled: false },
    Mounts: [{ Type: 'volume', Name: `${game}-world`, Destination: service.volumes[0].target, RW: true }],
    NetworkSettings: { Networks: { [stack.networks.game.name]: {} } },
    HostConfig: { NanoCpus: 2e9, PidsLimit: 1024, NetworkMode: stack.networks.game.name, RestartPolicy: { Name: 'no' },
      CapDrop: ['ALL'], CapAdd: [], SecurityOpt: ['no-new-privileges:true'], Devices: [],
      Memory: entry.resources.hardMemoryMiB * 1048576,
      PortBindings: Object.fromEntries(entry.container.publishedPorts.map(p =>
        [`${p.containerPort}/${p.protocol}`, [{ HostIp: '127.0.0.1', HostPort: String(p.hostPort) }]])) } };
  return { entry, stack, service, data };
}
export function access(data, beforeInspect = () => {}) {
  const calls = [];
  const docker = new DockerAccess({ getContainer: id => ({
    inspect: async () => { beforeInspect(id); return structuredClone(data); },
    start: async () => { calls.push(['start', id]); data.State.Status = 'running'; },
    stop: async options => { calls.push(['stop', id, options]); data.State.Status = 'exited'; }
  }) }, ['127.0.0.1']);
  return { docker, calls };
}
