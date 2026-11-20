import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { apply } from '../index.js';
import { readLatestPatrolReport, patrolReportPath } from '../src/patrol.js';
import { COVERAGE_VERSION } from '../src/cycle-coverage.js';

/**
 * A stored report must not be trusted past the version that produced it.
 *
 * The failure this guards is the one measured on 2026-11-20: the BOM and delivery
 * fixes were live in the running host, yet the panel still said the data flow was
 * not connected. The old recompute test asked "does the stored report have a
 * cycle_coverage field" -- true for the 11-19 report -- so nothing recomputed,
 * and the display would have stayed wrong until the next due patrol a week later.
 * "Was it ever written" is a migration check; "which code wrote it" is a staleness
 * check, and only the second one catches a logic change.
 */

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'coverage-stale-'));
  const storageDir = join(root, 'storage');
  const memoryRoot = join(root, 'memory');
  await mkdir(storageDir, { recursive: true });
  await mkdir(memoryRoot, { recursive: true });
  return { root, storageDir, memoryRoot };
}

/** Pre-write a weekly report whose coverage came from an OLDER computation. */
async function seedStaleReport(storageDir, version) {
  const at = new Date(Date.now() - 60_000).toISOString();
  const report = {
    kind: 'weekly',
    at,
    ok: true,
    findings: [],
    summary: { principles: 0, terminated_by: null },
    cycle_coverage: {
      ...(version === null ? {} : { version }),
      micro_execution: {
        schedule_delivery: { status: 'unknown', reason: 'no_delivery_source_connected' },
        outcome: { status: 'unknown', reason: 'runtime_snapshot_does_not_establish_outcome' },
        runtime_snapshot: { state: 'missing' },
      },
      memory: {
        distillation: { status: 'unknown', reason: 'stale_seed' },
        index: { status: 'observed', scope: 'index_file_only' },
        recall: { status: 'incomplete', observed: true, reason: 'invalid_records' },
      },
      governance: { decisions: { status: 'incomplete', observed: true, reason: 'invalid_records' } },
      cross_step_correlation: { status: 'unknown', reason: 'no_shared_cycle_identity_established' },
    },
  };
  const path = patrolReportPath(storageDir, 'weekly');
  // The report lives under <storage>/mind-patrol/; the directory is normally
  // created by writePatrolReport, but a seeded fixture has to create it first.
  // dirname, not a '/' split: patrolReportPath uses join, which yields '\' here.
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(report), 'utf8');
  return report;
}

function startPatrol(storageDir, memoryRoot) {
  let dispose;
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    provide() {}, set() {}, get: () => null,
    on(event, fn) { if (event === 'dispose') dispose = fn; },
    tools: { register: () => () => {} },
  };
  apply(ctx, {
    storageDir,
    patrol: { enabled: true, principles: [], memoryRoot, pendingAxiomCandidates: () => null },
  }, { loadDefineTool: () => (schema) => schema });
  return {
    async waitFor(predicate) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const report = await readLatestPatrolReport(storageDir, 'weekly');
        if (report && predicate(report)) return report;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return null;
    },
    dispose: () => { if (dispose) dispose(); },
  };
}

test('a report from an older coverage version is recomputed', async () => {
  const box = await sandbox();
  const seeded = await seedStaleReport(box.storageDir, COVERAGE_VERSION - 1);
  const patrol = startPatrol(box.storageDir, box.memoryRoot);
  try {
    // The stale seed claims delivery was never connected and recall was invalid.
    // After recompute those must be gone: the memory root here has no BOM-damaged
    // ledger and no receipts, so the NEW code reports its own honest states.
    const report = await patrol.waitFor((r) =>
      r.cycle_coverage?.version === COVERAGE_VERSION
      && r.cycle_coverage?.micro_execution?.schedule_delivery?.reason !== 'no_delivery_source_connected');
    assert.ok(report, 'coverage was never recomputed for a version-mismatched report');
    assert.equal(report.cycle_coverage.micro_execution.schedule_delivery.reason, 'no_delivery_receipts_written');
    assert.notEqual(report.cycle_coverage, seeded.cycle_coverage);
  } finally {
    patrol.dispose();
    await rm(box.root, { recursive: true, force: true });
  }
});

test('a report with no version field at all is also recomputed', async () => {
  const box = await sandbox();
  await seedStaleReport(box.storageDir, null);
  const patrol = startPatrol(box.storageDir, box.memoryRoot);
  try {
    const report = await patrol.waitFor((r) => r.cycle_coverage?.version === COVERAGE_VERSION);
    assert.ok(report, 'an unversioned report should be treated as stale');
  } finally {
    patrol.dispose();
    await rm(box.root, { recursive: true, force: true });
  }
});

test('a report already on the current version is not rewritten on every start', async () => {
  const box = await sandbox();
  const seeded = await seedStaleReport(box.storageDir, COVERAGE_VERSION);
  const patrol = startPatrol(box.storageDir, box.memoryRoot);
  try {
    // Same version => the due check alone decides. The seed is one minute old and
    // the weekly period is seven days, so no rewrite should happen.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const report = await readLatestPatrolReport(box.storageDir, 'weekly');
    assert.equal(report.at, seeded.at, 'a current-version report must not be recomputed each start');
  } finally {
    patrol.dispose();
    await rm(box.root, { recursive: true, force: true });
  }
});

test('coverage carries the version that produced it', async () => {
  const box = await sandbox();
  const patrol = startPatrol(box.storageDir, box.memoryRoot);
  try {
    const report = await patrol.waitFor((r) => r.cycle_coverage);
    assert.ok(report, 'no coverage was written at all');
    assert.equal(report.cycle_coverage.version, COVERAGE_VERSION);
  } finally {
    patrol.dispose();
    await rm(box.root, { recursive: true, force: true });
  }
});
