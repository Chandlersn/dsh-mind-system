import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryInbox } from '../health-inbox.js';
import { createPatrolReportDelivery } from '../src/patrol-report-delivery.js';
import { existsSync } from 'node:fs';
const valvesPath = existsSync(new URL('../../valves/src/patrol.js', import.meta.url)) ? '../../valves/src/patrol.js' : '../../dsh-valves/src/patrol.js';
const { writePatrolReport, readLatestPatrolReport } = await import(valvesPath);

const report = { kind: 'weekly', at: '2026-11-19T00:00:00.000Z', warnings: ['raw warning'], cycle_coverage: {
  micro_execution: { schedule_delivery: { status: 'unknown', reason: 'no_delivery_source_connected' },
    runtime_snapshot: { state: 'ready', unresolvedCandidates: [{ taskId: 'task', unresolved: { count: 1, first: { attemptId: 'attempt', status: 'started' } } }] } },
  memory: { recall: { status: 'error', reason: 'EACCES' } },
  cross_step_correlation: { status: 'unknown', reason: 'no_shared_cycle_identity_established' },
} };

async function fixture(fn) {
  const home = await mkdtemp(join(tmpdir(), 'patrol-delivery-'));
  const inbox = new MemoryInbox(() => home);
  const storage = join(home, 'storages');
  const service = { lastPatrol: (kind) => readLatestPatrolReport(storage, kind) };
  const disposers = [];
  const start = (options = {}) => {
    const consumer = createPatrolReportDelivery({ getValves: () => service, inbox, home, intervalMs: 100000, ...options });
    disposers.push(() => consumer.dispose());
    return consumer;
  };
  try { await fn({ home, inbox, storage, service, start }); }
  finally { disposers.forEach((dispose) => dispose()); await rm(home, { recursive: true, force: true }); }
}

test('persisted report is delivered once with only candidate coverage', async () => fixture(async ({ inbox, storage, start }) => {
  assert.equal((await writePatrolReport(storage, report)).ok, true);
  const a = start(); const b = start();
  await Promise.all([a.reconcile(), b.reconcile(), a.reconcile()]);
  const rows = await inbox.list();
  assert.equal(rows.length, 1); assert.equal(rows[0].times, 1);
  assert.match(rows[0].message, /跨步骤/); assert.match(rows[0].message, /EACCES/);
  assert.match(rows[0].message, /task \/ attempt/); assert.doesNotMatch(rows[0].message, /raw warning/);
  assert.equal(a.status().status, 'delivered');
}));

test('unchanged findings in a later report do not create another issue', async () => fixture(async ({ inbox, storage, start }) => {
  await writePatrolReport(storage, report);
  const consumer = start();
  await consumer.reconcile();
  await writePatrolReport(storage, { ...report, at: '2026-11-26T00:00:00.000Z' });
  await consumer.reconcile();
  const rows = await inbox.list();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].times, 1);
}));

test('failed inbox insert retries without requiring another patrol', async () => fixture(async ({ inbox, storage, start }) => {
  await writePatrolReport(storage, report);
  const original = inbox.post.bind(inbox); let fail = true;
  inbox.post = async (...args) => { if (fail) throw new Error('insert failed'); return original(...args); };
  const consumer = start(); await consumer.reconcile();
  assert.equal(consumer.status().status, 'retrying'); assert.equal((await inbox.list()).length, 0);
  fail = false; await consumer.reconcile(); assert.equal((await inbox.list()).length, 1);
}));

test('receipt failure after post recovers without reposting', async () => fixture(async ({ inbox, storage, start }) => {
  await writePatrolReport(storage, report);
  let fail = true;
  const consumer = start({ writeReceipt: async (...args) => { if (fail) throw new Error('receipt failed'); return writeFile(...args); } });
  await consumer.reconcile(); assert.equal(consumer.status().status, 'retrying');
  assert.equal((await inbox.list())[0].times, 1);
  fail = false; await consumer.reconcile();
  assert.equal(consumer.status().status, 'delivered'); assert.equal((await inbox.list())[0].times, 1);
  const restarted = start(); await restarted.reconcile(); assert.equal((await inbox.list())[0].times, 1);
}));

test('periodic reconciliation handles late service, missing and old reports', async () => fixture(async ({ inbox, storage, service, start }) => {
  let available = false;
  const consumer = start({ getValves: () => available ? service : undefined, intervalMs: 20 });
  await consumer.reconcile(); assert.equal(consumer.status().status, 'unavailable');
  available = true; await consumer.reconcile(); assert.equal(consumer.status().status, 'unknown');
  await writePatrolReport(storage, { kind: 'weekly', at: report.at });
  await consumer.reconcile(); assert.equal(consumer.status().status, 'unsupported_report');
  await writePatrolReport(storage, report);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && (await inbox.list()).length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await inbox.list()).length, 1);
}));
