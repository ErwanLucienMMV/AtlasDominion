import { Fault } from './security.mjs';
import { posix } from 'node:path';

const managementNetworks = new Set(['control', 'proxy', 'monitoring', 'atlas-control', 'atlas-proxy', 'atlas-monitoring']);
const hostSystemPaths = ['/', '/run', '/var/run', '/etc', '/proc', '/sys', '/dev', '/boot', '/var/lib/docker', '/var/lib/containerd'];
function unsafeMount(mount) {
  const paths = [mount.Source, mount.Destination].filter(value => typeof value === 'string').map(value => posix.normalize(value));
  if (paths.some(value => posix.basename(value) === 'docker.sock')) return true;
  if (mount.Type !== 'bind') return false;
  // normalize() retains a trailing slash; remove it so parent overlap cannot
  // be bypassed with /var/lib/ instead of /var/lib. Preserve root explicitly.
  const source = typeof mount.Source === 'string' ? posix.normalize(mount.Source).replace(/\/$/, '') || '/' : '/';
  return hostSystemPaths.some(path => source === path || (path !== '/' &&
    (source.startsWith(`${path}/`) || path.startsWith(`${source}/`))));
}

function unsafeIsolation(data) {
  const host = data.HostConfig ?? {};
  const shared = mode => mode === 'host' || mode?.startsWith('container:');
  const user = data.Config?.User;
  // Docker supplies User="" for the default root identity.
  const account = typeof user === 'string' ? user.split(':')[0].trim() : undefined;
  // Enforce the restrictions declared by every approved game template. Missing
  // required controls must not silently inherit a less restrictive daemon default.
  const emptyOptionalList = value => value == null || (Array.isArray(value) && value.length === 0);
  const noNewPrivileges = option => /^no-new-privileges(?:(?:=|:)true)?$/.test(option);
  const options = host.SecurityOpt;
  const unsafeSecurity = !Array.isArray(options) || options.some(option => typeof option !== 'string') ||
    !options.some(noNewPrivileges) || options.some(option =>
      (option.startsWith('no-new-privileges') && !noNewPrivileges(option)) || /^seccomp(?:=|:)unconfined$/.test(option));
  return !emptyOptionalList(host.CapAdd) || !Array.isArray(host.CapDrop) ||
    !host.CapDrop.some(capability => typeof capability === 'string' && capability.toUpperCase() === 'ALL') ||
    unsafeSecurity || ['Devices', 'DeviceRequests', 'DeviceCgroupRules'].some(key => !emptyOptionalList(host[key])) ||
    shared(host.NetworkMode) || shared(host.PidMode) || shared(host.IpcMode) ||
    (account !== undefined && (account === '' || account === 'root' || /^0+$/.test(account))) ||
    (data.Mounts ?? []).some(unsafeMount) ||
    managementNetworks.has(host.NetworkMode) ||
    Object.keys(data.NetworkSettings?.Networks ?? {}).some(name => managementNetworks.has(name));
}

export function verifyIdentity(instance, data, bindingAddresses) {
  if (!data.Id || data.Name !== `/${instance.container.name}` ||
    Object.entries(instance.container.requiredLabels).some(([key, value]) => data.Config?.Labels?.[key] !== value) ||
    data.HostConfig?.RestartPolicy?.Name !== 'no' || data.HostConfig?.NetworkMode === 'host' ||
    data.HostConfig?.PublishAllPorts || data.HostConfig?.Privileged || unsafeIsolation(data)) throw new Fault('IDENTITY_MISMATCH');
  const expected = instance.container.publishedPorts.map(p => `${p.containerPort}/${p.protocol}:${p.hostPort}`).sort();
  const actual = [];
  for (const [port, bindings] of Object.entries(data.HostConfig?.PortBindings ?? {})) {
    if (!Array.isArray(bindings) || !bindings.length) throw new Fault('PORT_MISMATCH');
    for (const binding of bindings) {
      if (!bindingAddresses.includes(binding.HostIp ?? '')) throw new Fault('PORT_MISMATCH');
      actual.push(`${port}:${binding.HostPort}`);
    }
  }
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw new Fault('PORT_MISMATCH');
  if (instance.resources.hardMemoryMiB !== null && data.HostConfig?.Memory !== instance.resources.hardMemoryMiB * 1048576) throw new Fault('IDENTITY_MISMATCH');
}
export class DockerAccess {
  constructor(client, bindingAddresses) { this.client = client; this.bindingAddresses = bindingAddresses; }
  async inspect(instance, pinnedId) {
    try {
      const container = this.client.getContainer(pinnedId ?? instance.container.name);
      const data = await container.inspect();
      verifyIdentity(instance, data, this.bindingAddresses);
      if (pinnedId && data.Id !== pinnedId) throw new Fault('IDENTITY_MISMATCH');
      return { data, container: this.client.getContainer(data.Id) };
    } catch (error) {
      if (error instanceof Fault) throw error;
      throw new Fault(error.statusCode === 404 ? 'MISSING_CONTAINER' : 'DOCKER_UNAVAILABLE');
    }
  }
}
