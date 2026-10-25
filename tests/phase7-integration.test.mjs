import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DockerAccess } from '../apps/docker-controller/docker.mjs';
import { ControllerService } from '../apps/docker-controller/service.mjs';
import { LifecycleObserver } from '../apps/docker-controller/monitoring.mjs';
import { createApplication } from '../apps/docker-controller/http.mjs';
import { ControllerClient } from '../apps/discord-api/controller.mjs';
import { DiscordService } from '../apps/discord-api/service.mjs';
import { BackupWorker } from '../apps/backup-worker/worker.mjs';
import { restoreArchive } from '../apps/backup-worker/archive.mjs';

const actor = { guildId: '123456789012345678', userId: '223456789012345678', roleIds: [] };
const policy = { allowedDiscordGuilds: [actor.guildId], allowedDiscordUsers: [actor.userId], allowedDiscordRoles: [] };
const cases = [['vrising', '/mnt/vrising/persistentdata', 'world1.save'], ['zomboid', '/home/steam/Zomboid', 'players.db'], ['palworld', '/palworld', 'Level.sav']];
for (const [game, containerPath, saveFile] of cases) test(`${game}: Discord selection, lifecycle, metrics, restart and isolated backup recovery`, async t => {
  const entry = JSON.parse(await readFile(new URL(`../infrastructure/games/${game}/instance.example.json`, import.meta.url)));
  Object.assign(entry.policy, policy);
  const root = await mkdtemp(join(tmpdir(), `atlas-phase7-${game}-`));
  const source = join(root, 'source'), destination = join(root, 'archives'), lockDirectory = join(root, 'locks');
  await mkdir(source); await mkdir(destination); await mkdir(lockDirectory);
  await writeFile(join(source, saveFile), `${game} mock persistent marker`);
  const data = { Id: `pinned-${game}`, Name: `/${entry.container.name}`, Config: { User: '1000:1000', Labels: entry.container.requiredLabels },
    State: { Status: 'created', ExitCode: 0 }, Mounts: [{ Type: 'volume', Name: `${game}-world`, Destination: containerPath }],
    HostConfig: { RestartPolicy: { Name: 'no' }, Memory: entry.resources.hardMemoryMiB * 1048576,
      PortBindings: Object.fromEntries(entry.container.publishedPorts.map(p => [`${p.containerPort}/${p.protocol}`, [{ HostIp: '127.0.0.1', HostPort: String(p.hostPort) }]])) } };
  const calls = [], audit = [];
  const docker = new DockerAccess({ getContainer: name => {
    assert.ok([entry.container.name, data.Id].includes(name));
    return { inspect: async () => structuredClone(data),
      start: async () => { assert.equal(name, data.Id); calls.push('start'); data.State.Status = 'running'; },
      stop: async options => { assert.equal(name, data.Id); assert.deepEqual(options, { t: 120 }); calls.push('stop'); data.State.Status = 'exited'; },
      stats: async () => ({ memory_stats: { usage: 4096 }, cpu_stats: { cpu_usage: { total_usage: 2e9 } } }) };
  } }, ['127.0.0.1']);
  const settings = { instances: [entry], policy, docker, backupLockDirectory: lockDirectory,
    capacity: { memoryMiB: 32768, cpuUnits: 8 }, timeoutMs: 180000, stopTimeoutSeconds: 120, audit: { append: async e => audit.push(e) } };
  const service = new ControllerService(settings); await service.reconcile();
  const secret = 's'.repeat(64), app = await createApplication(service, [secret]);
  await app.listen(0, '127.0.0.1'); t.after(() => app.close());
  const client = new ControllerClient({ url: await app.getUrl(), secret });
  const deliveries = [], discord = new DiscordService({ controller: client, applicationId: '323456789012345678', pollMs: 1,
    fetchImpl: async (_url, init) => { deliveries.push(JSON.parse(init.body)); return new Response('{}'); } });
  assert.deepEqual((await discord.autocomplete({ instance: game }, actor)).map(c => c.value), [entry.id]);
  let sequence = 423456789012345678n;
  const interaction = () => ({ id: String(sequence++), token: 'mock-only' });
  async function complete(action) {
    await discord.complete(interaction(), { action, instance: entry.id }, actor);
    const deadline = Date.now() + 2000;
    while (service.locks.size) { assert.ok(Date.now() < deadline); await delay(2); }
    assert.deepEqual(deliveries.at(-1).allowed_mentions, { parse: [] });
    return deliveries.at(-1).content;
  }
  assert.match(await complete('start'), /completed/);
  assert.match(await complete('start'), /already_running/);
  assert.equal((await client.status(entry.id, actor)).readiness, 'unverified');
  const observer = new LifecycleObserver(service, {}); observer.stopped = false;
  await observer.refresh();
  assert.ok(service.monitoring.render(service).includes(`atlas_container_memory_bytes{instance="${entry.id}",game_type="${game}"} 4096`));
  const restarted = new ControllerService(settings); await restarted.reconcile();
  assert.ok(restarted.reservations.has(entry.id));
  await assert.rejects(client.operate(entry.id, 'stop', { ...actor, userId: '923456789012345678' }, String(sequence++)));
  const job = { instanceId: entry.id, source, destination, volumeName: `${game}-world`, containerPath,
    intervalSeconds: 60, keep: 2, minimumFreeBytes: 0, allowRetentionDeletion: false };
  const reports = [], worker = new BackupWorker({ config: { lockDirectory, jobs: [job] }, instances: [entry], docker, report: e => reports.push(e) });
  await assert.rejects(worker.run(job), /Clean stopped/);
  assert.equal(reports.at(-1).outcome, 'failed');
  assert.match(await complete('stop'), /completed/);
  assert.match(await complete('stop'), /already_stopped/);
  await observer.refresh(); assert.equal(service.monitoring.exits.get(entry.id), undefined);
  const archive = await worker.run(job), restored = join(root, 'isolated-restore');
  assert.equal(reports.at(-1).outcome, 'verified');
  await restoreArchive(archive, restored, entry.id);
  assert.equal(await readFile(join(restored, saveFile), 'utf8'), `${game} mock persistent marker`);
  await assert.rejects(restoreArchive(archive, restored, entry.id));
  assert.match(await complete('start'), /completed/);
  assert.equal(await readFile(join(source, saveFile), 'utf8'), `${game} mock persistent marker`);
  assert.deepEqual(calls, ['start', 'stop', 'start']);
  data.State.Status = 'exited'; data.State.ExitCode = 137;
  await assert.rejects(worker.run(job), /Clean stopped/);
  await assert.rejects(client.operate(entry.id, 'stop', actor, String(sequence++)), /OPERATION_CONFLICT/);
  assert.equal(await complete('stop'), 'Another operation is in progress. Check status before retrying.');
  assert.ok(audit.some(e => e.operation === 'stop' && e.outcome === 'completed'));
  // Let any operation completion bookkeeping settle before the local listener closes.
  await delay(1);
});
