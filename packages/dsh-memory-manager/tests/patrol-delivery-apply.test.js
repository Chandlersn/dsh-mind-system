import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const noop = () => {};

async function waitFor(check, description) {
  const deadline = Date.now() + 5000;
  let value;
  while (Date.now() < deadline) {
    value = await check();
    if (value) return value;
    await sleep(20);
  }
  assert.fail(`Timed out waiting for ${description}`);
}

test('apply delivers a persisted patrol after valves appears and stops on dispose', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'patrol-apply-'));
  const oldHome = process.env.DSH_HOME;
  const oldSagBin = process.env.SAG_BIN;
  process.env.DSH_HOME = home;
  process.env.SAG_BIN = path.join(home, 'missing-sag-executable');
  let dispose;
  t.after(async () => {
    dispose?.();
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
    if (oldSagBin === undefined) delete process.env.SAG_BIN; else process.env.SAG_BIN = oldSagBin;
    await rm(home, { recursive: true, force: true });
  });

  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  const storage = path.join(home, 'storages');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# Isolated index\n');
  const mod = await import('../server.js');
  assert.equal(mod.dshHome(), path.resolve(home));
  assert.equal(path.dirname(home), path.resolve(tmpdir()));
  assert.ok(path.basename(home).startsWith('patrol-apply-'));
  const valvesPath = existsSync(new URL('../../valves/src/patrol.js', import.meta.url))
    ? '../../valves/src/patrol.js' : '../../dsh-valves/src/patrol.js';
  const { writePatrolReport, readLatestPatrolReport } = await import(valvesPath);
  const report = { kind: 'weekly', at: '2026-11-19T00:00:00.000Z', cycle_coverage: {
    cross_step_correlation: { status: 'unknown', reason: 'no_shared_cycle_identity_established' },
  } };
  const persisted = await writePatrolReport(storage, report);
  assert.equal(persisted.ok, true);
  assert.ok(path.relative(home, persisted.path) && !path.relative(home, persisted.path).startsWith('..'));
  assert.deepEqual(JSON.parse(await readFile(persisted.path, 'utf8')), report);

  let handler;
  let service;
  let reads = 0;
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on: () => noop,
    get: (name) => name === 'valves' ? service : undefined,
    set: noop,
    emit: noop,
    inject(_names, fn) {
      fn({ webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } },
        connection: { requestRejection: () => undefined }, effect: (fn) => fn() });
    },
  };
  dispose = mod.apply(ctx, { memoryRoot: root, skillRoot: skills, dshRoot: process.env.DSH_INSTALL_DIR,
    dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0, patrolDeliveryIntervalMs: 30 });
  assert.equal(typeof handler, 'function');
  async function overview() {
    let status, body;
    await handler({ method: 'GET', url: '/api/memory-org/overview' }, {
      writeHead(code) { status = code; }, end(value) { body = value; },
    });
    assert.equal(status, 200);
    return JSON.parse(body)[0].patrolDelivery;
  }
  await waitFor(async () => (await overview())?.status === 'unavailable', 'unavailable overview status');
  const inboxPath = path.join(storage, 'memory-inbox.json');
  assert.equal(existsSync(inboxPath), false);
  service = { lastPatrol: async (kind) => { reads++; return readLatestPatrolReport(storage, kind); } };
  const delivered = await waitFor(async () => {
    const status = await overview();
    return status?.status === 'delivered' && status;
  }, 'automatic delivery');
  assert.ok(reads > 0);
  const receiptDir = path.join(storage, 'patrol-delivery-receipts');
  const receipts = await readdir(receiptDir);
  assert.deepEqual(receipts, [`${delivered.reportId}.json`]);
  const receipt = JSON.parse(await readFile(path.join(receiptDir, receipts[0]), 'utf8'));
  assert.equal(receipt.version, 1);
  assert.equal(receipt.reportId, delivered.reportId);
  const inbox = JSON.parse(await readFile(inboxPath, 'utf8'));
  const items = Object.values(inbox.items);
  assert.equal(items.length, 1);
  assert.equal(items[0].times, 1);
  assert.equal(items[0].fingerprint, receipt.fingerprint);
  assert.equal(items[0].code, 'weekly-cycle-coverage');
  await waitFor(() => reads >= 3, 'repeated timer ticks');
  assert.deepEqual(JSON.parse(await readFile(inboxPath, 'utf8')), inbox);
  assert.deepEqual(await readdir(receiptDir), receipts);

  dispose();
  dispose = undefined;
  const readsAtDispose = reads;
  await writePatrolReport(storage, { ...report, at: '2026-11-26T00:00:00.000Z', cycle_coverage: {
    memory: { recall: { status: 'error', reason: 'after-dispose' } },
  } });
  await sleep(180);
  assert.equal(reads, readsAtDispose, 'dispose stops the timer');
  assert.deepEqual(JSON.parse(await readFile(inboxPath, 'utf8')), inbox);
  assert.deepEqual(await readdir(receiptDir), receipts);
});
