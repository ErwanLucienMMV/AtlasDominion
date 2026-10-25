import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRegistry } from '../libs/server-registry/index.mjs';
import { LifecycleObserver } from '../apps/docker-controller/monitoring.mjs';
import { BackupWorker, validateBackupConfig } from '../apps/backup-worker/worker.mjs';
import { restoreArchive } from '../apps/backup-worker/archive.mjs';
import { fixture, actor, harness, settled } from './phase8-harness.mjs';

test('unknown game manifest is deny-by-default and uses only existing generic capabilities', () => {
  assert.equal(validateRegistry([fixture])[0].gameType, 'nebula-sandbox');
  assert.deepEqual(fixture.policy.allowedDiscordUsers, []);
  assert.deepEqual(fixture.policy.allowedDiscordRoles, []);
  assert.equal(fixture.adapter.lifecycle, 'generic');
});

test('unknown pre-provisioned game crosses API, Discord, lifecycle, metrics and verified backup boundaries', async t => {
  const h = await harness(t), id = h.instances[0].id;
  assert.equal((await h.client.list(actor)).items[0].gameType, 'nebula-sandbox');
  assert.deepEqual((await h.discord.autocomplete({ instance: 'nebula' }, actor)).map(c => c.value), [id]);
  await assert.rejects(h.client.status(id, { ...actor, userId: '923456789012345678' }));
  await assert.rejects(h.client.status('not-registered', actor));
  await h.discord.complete({ id: '423456789012345678', token: 'synthetic-only' }, { action: 'start', instance: id }, actor);
  await settled(h.service);
  assert.match(h.deliveries.at(-1).content, /completed/);
  assert.equal((await h.client.status(id, actor)).readiness, 'unverified');
  const observer = new LifecycleObserver(h.service, {}); observer.stopped = false;
  await observer.refresh();
  const response = await fetch(`${await h.app.getUrl()}/metrics`, { headers: { authorization: `Bearer ${h.secret}` } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /atlas_container_memory_bytes\{instance="nebula-lab",game_type="nebula-sandbox"\} 4096/);
  await h.discord.complete({ id: '423456789012345679', token: 'synthetic-only' }, { action: 'stop', instance: id }, actor);
  await settled(h.service);
  assert.match(h.deliveries.at(-1).content, /completed/);
  assert.deepEqual(h.calls.filter(c => ['start', 'stop'].includes(c[0])), [['start', id], ['stop', id]]);

  const root = await mkdtemp(join(tmpdir(), 'atlas-phase8-'));
  const source = join(root, 'source'), destination = join(root, 'archives'), lockDirectory = join(root, 'locks');
  for (const dir of [source, destination, lockDirectory]) await mkdir(dir);
  await writeFile(join(source, 'world.save'), 'synthetic unknown-game persistent marker');
  const job = { instanceId: id, source, destination, volumeName: `world-${id}`, containerPath: '/world',
    intervalSeconds: 60, keep: 2, minimumFreeBytes: 0, allowRetentionDeletion: false };
  const config = { lockDirectory, jobs: [job] };
  assert.equal(validateBackupConfig(config, h.instances).jobs[0].instanceId, id);
  const reports = [], worker = new BackupWorker({ config, instances: h.instances, docker: h.docker, report: e => reports.push(e) });
  const archive = await worker.run(job), restored = join(root, 'isolated-restore');
  assert.equal(reports.at(-1).outcome, 'verified');
  await restoreArchive(archive, restored, id);
  assert.equal(await readFile(join(restored, 'world.save'), 'utf8'), await readFile(join(source, 'world.save'), 'utf8'));
  await assert.rejects(restoreArchive(archive, restored, id));
  assert.ok(h.audit.every(e => !JSON.stringify(e).includes(actor.userId)));
});
