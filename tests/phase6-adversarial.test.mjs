import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, link, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { inventory, createArchive, verifyArchive, restoreArchive } from '../apps/backup-worker/archive.mjs';
import { BackupWorker, validateBackupConfig } from '../apps/backup-worker/worker.mjs';
import { acquireInstanceLock } from '../libs/instance-lock.mjs';
import { DockerAccess } from '../apps/docker-controller/docker.mjs';

// Requirements: PHASE_6_BACKUP.md, SECURITY.md and OPERATIONS.md.
// All filesystem operations are confined to newly generated temporary fixtures.
// Preserve those fixtures as evidence; never contact a real Docker Engine.
const instance = JSON.parse(await readFile(new URL('./fixtures/instance.json', import.meta.url)));
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'atlas-phase6-adversarial-'));
  const source = join(root, 'source'), destination = join(root, 'archives'), lockDirectory = join(root, 'locks');
  for (const path of [source, destination, lockDirectory]) await mkdir(path);
  await mkdir(join(source, 'empty'));
  await writeFile(join(source, 'level.dat'), Buffer.from([0, 255, 13, 10, 0, 128]));
  const job = { instanceId: instance.id, source, destination, volumeName: 'world', containerPath: '/data', intervalSeconds: 60, keep: 1, minimumFreeBytes: 0, allowRetentionDeletion: false };
  const data = { Id: 'pinned', Name: `/${instance.container.name}`, Config: { Labels: instance.container.requiredLabels, User: '1000:1000' },
    State: { Status: 'exited', ExitCode: 0, OOMKilled: false }, Mounts: [{ Type: 'volume', Name: 'world', Destination: '/data' }],
    HostConfig: { CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], RestartPolicy: { Name: 'no' }, Memory: instance.resources.hardMemoryMiB * 1048576,
      PortBindings: Object.fromEntries(instance.container.publishedPorts.map(p => [`${p.containerPort}/${p.protocol}`, [{ HostIp: '192.0.2.10', HostPort: String(p.hostPort) }]])) } };
  const events = [], config = { lockDirectory, jobs: [job] };
  const worker = new BackupWorker({ config, instances: [instance], docker: { inspect: async () => ({ data }) }, report: e => events.push(e) });
  return { root, source, destination, lockDirectory, job, data, events, worker, config };
}
async function archived() {
  const f = await fixture(); f.archive = join(f.destination, 'candidate');
  await createArchive(f.source, f.archive, instance.id); return f;
}
async function absent(path) { await assert.rejects(lstat(path), { code: 'ENOENT' }); }

for (const [name, state] of Object.entries({ running: { Status: 'running', ExitCode: 0 }, paused: { Status: 'paused', ExitCode: 0 }, restarting: { Status: 'restarting', ExitCode: 0 }, created: { Status: 'created', ExitCode: 0 }, dead: { Status: 'dead', ExitCode: 0 }, oom: { Status: 'exited', ExitCode: 0, OOMKilled: true }, nonzero: { Status: 'exited', ExitCode: 1 }, missingExit: { Status: 'exited' }, stringExit: { Status: 'exited', ExitCode: '0' } })) {
  test(`backup rejects ${name} state before creating archive evidence`, async () => {
    const f = await fixture(); f.data.State = state;
    await assert.rejects(f.worker.run(f.job)); assert.deepEqual(await readdir(f.destination), []);
    assert.deepEqual(f.events, [{ instanceId: instance.id, outcome: 'failed' }]);
    const release = await acquireInstanceLock(f.lockDirectory, instance.id); await release();
  });
}
for (const [name, mount] of Object.entries({ bind: { Type: 'bind', Name: 'world', Destination: '/data' }, wrongName: { Type: 'volume', Name: 'other', Destination: '/data' }, wrongDestination: { Type: 'volume', Name: 'world', Destination: '/elsewhere' } })) {
  test(`backup rejects ${name} volume mapping`, async () => {
    const f = await fixture(); f.data.Mounts = [mount]; await assert.rejects(f.worker.run(f.job));
    assert.deepEqual(await readdir(f.destination), []);
  });
}
for (const [name, mutate] of Object.entries({ running: d => d.State.Status = 'running', oom: d => d.State.OOMKilled = true, crashed: d => d.State.ExitCode = 137 })) {
  test(`post-copy ${name} state prevents verified marker and preserves evidence`, async () => {
    const f = await fixture(); let calls = 0;
    f.worker.docker.inspect = async (_entry, pinned) => {
      calls++; if (calls === 2) { assert.equal(pinned, 'pinned'); mutate(f.data); }
      return { data: f.data };
    };
    await assert.rejects(f.worker.run(f.job));
    const root = join(f.destination, instance.id), names = await readdir(root);
    assert.equal(names.length, 1); await verifyArchive(join(root, names[0]), instance.id);
    await absent(join(root, names[0], 'verified.json')); assert.equal(f.events[0].outcome, 'failed');
  });
}
for (const [name, mutate] of Object.entries({ labels: d => d.Config.Labels = {}, privileged: d => d.HostConfig.Privileged = true, publicExtraPort: d => d.HostConfig.PortBindings['1234/tcp'] = [{ HostIp: '0.0.0.0', HostPort: '1234' }], hostNetwork: d => d.HostConfig.NetworkMode = 'host', rootUser: d => d.Config.User = '0', replacedId: d => d.Id = 'replacement' })) {
  test(`real DockerAccess revalidation rejects post-copy ${name}`, async () => {
    const f = await fixture(); let calls = 0;
    f.worker.docker = new DockerAccess({ getContainer: () => ({ inspect: async () => { calls++; if (calls === 2) mutate(f.data); return structuredClone(f.data); } }) }, ['192.0.2.10']);
    await assert.rejects(f.worker.run(f.job)); assert.equal(f.events.at(-1).outcome, 'failed');
    const names = await readdir(join(f.destination, instance.id));
    await absent(join(f.destination, instance.id, names[0], 'verified.json'));
  });
}
for (const [name, mutate] of Object.entries({ missingFile: m => m.entries = m.entries.filter(e => e.path !== 'level.dat'), duplicate: m => m.entries.push(m.entries[0]), traversal: m => m.entries[0].path = '../outside', absolute: m => m.entries[0].path = '/outside', backslash: m => m.entries[0].path = 'a\\b', drive: m => m.entries[0].path = 'C:escape', nul: m => m.entries[0].path = 'a\0b', wrongType: m => m.entries[0].type = 'socket', wrongSize: m => m.entries.find(e => e.type === 'file').size++, wrongHash: m => m.entries.find(e => e.type === 'file').sha256 = '0'.repeat(64), wrongVersion: m => m.version = 2, wrongInstance: m => m.instanceId = 'other' })) {
  test(`restore rejects ${name} manifest before creating output`, async () => {
    const f = await archived(), path = join(f.archive, 'manifest.json');
    const manifest = JSON.parse(await readFile(path)); mutate(manifest); await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(restoreArchive(f.archive, join(f.root, 'restore'), instance.id)); await absent(join(f.root, 'restore'));
  });
}
for (const raw of ['null', '[]', '{}', '{', '42', '{"version":1,"entries":[null]}']) {
  test(`restore fails closed on malformed manifest ${raw}`, async () => {
    const f = await archived(); await writeFile(join(f.archive, 'manifest.json'), raw);
    await assert.rejects(restoreArchive(f.archive, join(f.root, 'restore'), instance.id)); await absent(join(f.root, 'restore'));
  });
}
test('binary bytes, empty files, Unicode and nested empty directories roundtrip', async () => {
  const f = await fixture(); await writeFile(join(f.source, 'empty-file'), ''); await mkdir(join(f.source, 'empty', '世界'));
  const archive = await f.worker.run(f.job), restored = join(f.root, 'restored'); await restoreArchive(archive, restored, instance.id);
  assert.deepEqual(await inventory(restored), await inventory(f.source)); await absent(join(archive, 'restore-test'));
});
test('unexpected archive data fails integrity validation', async () => {
  const f = await archived(); await writeFile(join(f.archive, 'data', 'unlisted'), 'secret');
  await assert.rejects(verifyArchive(f.archive, instance.id), /integrity/);
});
test('existing restore directory and its sentinel remain untouched', async () => {
  const f = await archived(), restored = join(f.root, 'existing'); await mkdir(restored); await writeFile(join(restored, 'sentinel'), 'preserve');
  await assert.rejects(restoreArchive(f.archive, restored, instance.id)); assert.deepEqual(await readdir(restored), ['sentinel']);
  assert.equal(await readFile(join(restored, 'sentinel'), 'utf8'), 'preserve');
});
test('source hard links are rejected without copying shared secrets', async () => {
  const f = await fixture(); await link(join(f.source, 'level.dat'), join(f.source, 'alias'));
  await assert.rejects(f.worker.run(f.job), /Links/); assert.equal(f.events[0].outcome, 'failed');
});
test('source directory junction is rejected without reading external data', async () => {
  const f = await fixture(), external = join(f.root, 'external'); await mkdir(external); await writeFile(join(external, 'secret'), 'private');
  await symlink(external, join(f.source, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.worker.run(f.job), /Links/); assert.equal(await readFile(join(external, 'secret'), 'utf8'), 'private');
});
test('retention preserves damaged, incomplete and unknown archive evidence', async () => {
  const f = await fixture(), archive = await f.worker.run(f.job), root = join(f.destination, instance.id);
  await writeFile(join(archive, 'data', 'level.dat'), 'damage');
  const incomplete = '1000000000000-00000000-0000-0000-0000-000000000000'; await mkdir(join(root, incomplete));
  await mkdir(join(root, 'operator-evidence'));
  await f.worker.run({ ...f.job, allowRetentionDeletion: true });
  assert.equal((await readdir(root)).length, 4); assert.ok(await lstat(archive));
});
test('retention must preserve a marker lacking restore timestamp', async () => {
  const f = await fixture(), archive = await f.worker.run(f.job);
  await writeFile(join(archive, 'verified.json'), JSON.stringify({ instanceId: instance.id }));
  await f.worker.run({ ...f.job, allowRetentionDeletion: true });
  assert.ok(await lstat(archive), 'incomplete restore marker is evidence, not deletion eligibility');
});
test('scheduler never overlaps ticks and shutdown waits for active job without scheduling another', async () => {
  const f = await fixture(); let release, started; const began = new Promise(r => started = r), blocked = new Promise(r => release = r); let calls = 0;
  f.worker.run = async () => { calls++; started(); await blocked; };
  const active = f.worker.tick(1000); await began; await f.worker.tick(62000); assert.equal(calls, 1);
  f.worker.stop(); release(); await active; await f.worker.tick(123000); assert.equal(calls, 1); assert.equal(f.worker.active, false);
});
test('failed job does not prevent the next configured job', async () => {
  const f = await fixture(), second = { ...f.job, instanceId: 'second-fixture' };
  f.worker.config.jobs.push(second); const calls = []; f.worker.run = async j => { calls.push(j.instanceId); if (j === f.worker.config.jobs[0]) throw Error('offline'); };
  await f.worker.tick(0); assert.deepEqual(calls, [instance.id, second.instanceId]);
});
test('failure reporting does not leak Engine exception secrets or approved host paths', async () => {
  const f = await fixture(); f.worker.docker.inspect = async () => { throw Error(`Bearer supersecret ${f.source}`); };
  await assert.rejects(f.worker.run(f.job)); assert.deepEqual(f.events, [{ instanceId: instance.id, outcome: 'failed' }]);
});
test('worker configuration is isolated from later caller mutation', async () => {
  const f = await fixture(); f.config.jobs[0].source = 'attacker'; f.config.lockDirectory = 'attacker';
  assert.equal(f.worker.config.jobs[0].source, f.source); assert.equal(f.worker.config.lockDirectory, f.lockDirectory);
});
for (const [field, values] of Object.entries({ intervalSeconds: [59, 60.5, NaN, Infinity, '60', Number.MAX_SAFE_INTEGER + 1], keep: [0, -1, 1.5, '1'], minimumFreeBytes: [-1, NaN, Infinity, '0'], allowRetentionDeletion: [undefined, 1, 'false'], volumeName: ['../world', 'a/b', '', 'a'.repeat(129)], containerPath: ['relative', '/a/../data', '/a/./data'] })) {
  for (const value of values) test(`configuration rejects ${field}=${String(value)}`, async () => {
    const f = await fixture(); assert.throws(() => validateBackupConfig({ ...f.config, jobs: [{ ...f.job, [field]: value }] }, [instance]));
  });
}
test('configuration rejects duplicate jobs and lock/source/destination nesting', async () => {
  const f = await fixture(); assert.throws(() => validateBackupConfig({ ...f.config, jobs: [f.job, f.job] }, [instance]));
  for (const lockDirectory of [f.source, join(f.source, 'lock'), f.destination, join(f.destination, 'lock')])
    assert.throws(() => validateBackupConfig({ ...f.config, lockDirectory }, [instance]));
});
test('configuration rejects Windows path aliases that overlap active data', async () => {
  const f = await fixture();
  if (process.platform !== 'win32') { assert.throws(() => validateBackupConfig({ ...f.config, jobs: [{ ...f.job, destination: f.source }] }, [instance])); return; }
  assert.throws(() => validateBackupConfig({ ...f.config, jobs: [{ ...f.job, destination: f.source.toUpperCase() }] }, [instance]));
});
test('persistent lock permits exactly one of many simultaneous owners', async () => {
  const f = await fixture(), attempts = await Promise.allSettled(Array.from({ length: 20 }, () => acquireInstanceLock(f.lockDirectory, instance.id)));
  const winners = attempts.filter(r => r.status === 'fulfilled'); assert.equal(winners.length, 1); await winners[0].value();
});
for (const id of ['../escape', '/absolute', '', 'UPPER', 'a/b', 'a\\b', 'x'.repeat(64)]) test(`persistent lock rejects unsafe ID ${JSON.stringify(id)}`, async () => {
  const f = await fixture(); await assert.rejects(acquireInstanceLock(f.lockDirectory, id)); assert.deepEqual(await readdir(f.lockDirectory), []);
});
test('lock release failure must not report backup success', async () => {
  const f = await fixture(); let count = 0;
  f.worker.docker.inspect = async () => { if (++count === 2) await writeFile(join(f.lockDirectory, instance.id, 'operator-evidence'), 'preserve'); return { data: f.data }; };
  await assert.rejects(f.worker.run(f.job));
  assert.equal(f.events.some(e => e.outcome === 'verified'), false, 'a stuck lifecycle lock is an operational failure');
  assert.equal(f.events.at(-1)?.outcome, 'failed');
});
test('manifest digest describes content but cannot authenticate malicious storage edits', async () => {
  const f = await archived(), path = join(f.archive, 'manifest.json'), manifest = JSON.parse(await readFile(path));
  const bytes = Buffer.from('operator storage is a trust boundary'); await writeFile(join(f.archive, 'data', 'level.dat'), bytes);
  Object.assign(manifest.entries.find(e => e.path === 'level.dat'), { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  await writeFile(path, JSON.stringify(manifest)); await verifyArchive(f.archive, instance.id);
});
test('restore refuses an archive root that is a directory link', async () => {
  const f = await archived(), alias = join(f.destination, 'alias');
  await symlink(f.archive, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restoreArchive(alias, join(f.root, 'restored'), instance.id));
  await absent(join(f.root, 'restored'));
});
test('restoration destination link is refused and its target remains untouched', async () => {
  const f = await archived(), target = join(f.root, 'target'), alias = join(f.root, 'alias'); await mkdir(target);
  await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(restoreArchive(f.archive, alias, instance.id)); assert.deepEqual(await readdir(target), []);
});
test('retention meets keep count after clock rollback while preserving replacement', async () => {
  const f = await fixture(), archive = await f.worker.run(f.job), root = join(f.destination, instance.id);
  await rename(archive, join(root, '9999999999999-00000000-0000-0000-0000-000000000000'));
  const replacement = await f.worker.run({ ...f.job, allowRetentionDeletion: true });
  assert.deepEqual(await readdir(root), [replacement.split(/[\\/]/).at(-1)]);
});
test('lock directory junction is rejected without creating ownership in its target', async () => {
  const f = await fixture(), alias = join(f.root, 'lock-alias');
  await symlink(f.lockDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(acquireInstanceLock(alias, instance.id)); assert.deepEqual(await readdir(f.lockDirectory), []);
});
test('unknown registry strategy fails before scheduling any work', async () => {
  const f = await fixture(), entry = structuredClone(instance); entry.adapter.backup = 'none';
  assert.throws(() => validateBackupConfig(f.config, [entry]));
});
test('missing Engine and unavailable Engine fail privately with no archive creation', async () => {
  for (const statusCode of [404, 500]) {
    const f = await fixture();
    f.worker.docker = new DockerAccess({ getContainer: () => ({ inspect: async () => { throw { statusCode }; } }) }, []);
    await assert.rejects(f.worker.run(f.job), new RegExp(statusCode === 404 ? 'MISSING_CONTAINER' : 'DOCKER_UNAVAILABLE'));
    assert.deepEqual(await readdir(f.destination), []); assert.deepEqual(f.events, [{ instanceId: instance.id, outcome: 'failed' }]);
  }
});
