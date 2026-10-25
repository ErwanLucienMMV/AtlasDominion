import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyIdentity } from '../apps/docker-controller/docker.mjs';
import { BackupWorker } from '../apps/backup-worker/worker.mjs';
import { fixture, access } from './phase7-harness.mjs';

for (const option of ['no-new-privileges', 'no-new-privileges:true', 'no-new-privileges=true'])
  test(`accept Engine no-new-privileges spelling ${option} and nullable optional lists`, () => {
    const { entry, data } = fixture('palworld');
    data.HostConfig.SecurityOpt = [option];
    for (const key of ['CapAdd', 'Devices', 'DeviceRequests', 'DeviceCgroupRules']) data.HostConfig[key] = null;
    assert.doesNotThrow(() => verifyIdentity(entry, data, ['127.0.0.1']));
  });

for (const [name, mutate] of Object.entries({
  missingDrop: h => { delete h.CapDrop; },
  nullDrop: h => { h.CapDrop = null; },
  stringDrop: h => { h.CapDrop = 'ALL'; },
  partialDrop: h => { h.CapDrop = ['SYS_ADMIN']; },
  malformedGrants: h => { h.CapAdd = 'SYS_ADMIN'; },
  missingSecurity: h => { delete h.SecurityOpt; },
  nullSecurity: h => { h.SecurityOpt = null; },
  malformedSecurity: h => { h.SecurityOpt = [null]; },
  falsePrivilege: h => { h.SecurityOpt.push('no-new-privileges=false'); },
  conflictingPrivilege: h => { h.SecurityOpt.push('no-new-privileges:false'); },
  legacyUnconfined: h => { h.SecurityOpt.push('seccomp:unconfined'); },
  deviceRules: h => { h.DeviceCgroupRules = ['b 8:* rwm']; },
  deviceRequests: h => { h.DeviceRequests = [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }]; },
  malformedDevices: h => { h.Devices = {}; }
})) test(`isolation fails closed on ${name}`, () => {
  const { entry, data } = fixture('palworld'); mutate(data.HostConfig);
  assert.throws(() => verifyIdentity(entry, data, ['127.0.0.1']), { code: 'IDENTITY_MISMATCH' });
});

for (const field of ['Name', 'Destination', 'Type', 'missing'])
  test(`post-copy volume ${field} drift preserves unverified evidence and releases ownership`, async () => {
    const { entry, data } = fixture('palworld');
    const root = await mkdtemp(join(tmpdir(), 'atlas-phase7-mount-fix-'));
    const source = join(root, 'source'), destination = join(root, 'archives'), lockDirectory = join(root, 'locks');
    for (const path of [source, destination, lockDirectory]) await mkdir(path);
    await writeFile(join(source, 'marker.sav'), 'preserve world bytes');
    const job = { instanceId: entry.id, source, destination, volumeName: data.Mounts[0].Name,
      containerPath: data.Mounts[0].Destination, intervalSeconds: 60, keep: 1, minimumFreeBytes: 0, allowRetentionDeletion: false };
    let inspections = 0;
    const { docker } = access(data, () => {
      if (++inspections === 2) {
        if (field === 'missing') data.Mounts = [];
        else data.Mounts[0][field] = 'drifted';
      }
    });
    const reports = [], worker = new BackupWorker({ config: { lockDirectory, jobs: [job] }, instances: [entry], docker, report: e => reports.push(e) });
    await assert.rejects(worker.run(job), /Backup volume mismatch/);
    assert.deepEqual(reports, [{ instanceId: entry.id, outcome: 'failed' }]);
    const archives = await readdir(join(destination, entry.id)); assert.equal(archives.length, 1);
    const archive = join(destination, entry.id, archives[0]);
    await assert.rejects(readFile(join(archive, 'verified.json')), { code: 'ENOENT' });
    assert.equal(await readFile(join(archive, 'data', 'marker.sav'), 'utf8'), 'preserve world bytes');
    assert.equal(await readFile(join(source, 'marker.sav'), 'utf8'), 'preserve world bytes');
    assert.deepEqual(await readdir(lockDirectory), []);
  });
