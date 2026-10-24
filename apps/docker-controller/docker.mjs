import { Fault } from './security.mjs';

export function verifyIdentity(instance, data, bindingAddresses) {
  if (!data.Id || data.Name !== `/${instance.container.name}` ||
    Object.entries(instance.container.requiredLabels).some(([key, value]) => data.Config?.Labels?.[key] !== value) ||
    data.HostConfig?.RestartPolicy?.Name !== 'no' || data.HostConfig?.NetworkMode === 'host' ||
    data.HostConfig?.PublishAllPorts || data.HostConfig?.Privileged) throw new Fault('IDENTITY_MISMATCH');
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
