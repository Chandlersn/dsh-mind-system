import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCycleCoverage } from '../src/cycle-coverage.js';
import { apply, createRuntime } from '../index.js';
import { readLatestPatrolReport, writePatrolReport } from '../src/patrol.js';

const row = (value) => `${JSON.stringify(value)}\n`;

test('coverage distinguishes observations, corrupt evidence and read errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cycle-coverage-'));
  const memory = join(root, 'memory');
  const storage = join(root, 'storages');
  try {
    await mkdir(join(memory, '.usage'), { recursive: true });
    await mkdir(storage);
    await writeFile(join(memory, '.write-ledger.jsonl'), row({ tool: 'memory-manager', key: 'functions/x.md', hash: 'abc' }) + '{broken\n');
    await writeFile(join(memory, 'MEMORY.md'), '# Index\n');
    await writeFile(join(memory, '.usage', '2026-11.jsonl'), row({ kind: 'recall', href: 'functions/x.md' }));
    await mkdir(join(storage, 'mind-valves.jsonl'));
    const out = await collectCycleCoverage({ storageDir: storage, memoryRoot: memory });
    assert.equal(out.memory.distillation.status, 'incomplete');
    assert.equal(out.memory.distillation.tracked_function_write_observed, true);
    assert.equal(out.memory.index.status, 'observed');
    assert.equal(out.memory.recall.status, 'observed');
    assert.equal(out.governance.decisions.status, 'error');
    assert.equal(out.micro_execution.schedule_delivery.status, 'unknown');
    assert.equal(out.micro_execution.outcome.status, 'unknown');
    assert.equal(out.cross_step_correlation.status, 'unknown');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recall coverage preserves corrupt, absent and observed source distinctions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cycle-recall-integrity-'));
  const memoryRoot = join(root, 'memory');
  const storageDir = join(root, 'storages');
  try {
    await mkdir(join(memoryRoot, '.usage', 'archive'), { recursive: true });
    await mkdir(storageDir);
    const read = async () => (await collectCycleCoverage({ storageDir, memoryRoot })).memory.recall;
    assert.deepEqual(await read(), { status: 'unknown', reason: 'no_recall_evidence' });
    await writeFile(join(memoryRoot, '.usage.jsonl'), '{broken\nnull\n');
    assert.deepEqual(await read(), { status: 'incomplete', observed: false, reason: 'invalid_records' });
    await writeFile(join(memoryRoot, '.usage', '2026-11.jsonl'), row({ kind: 'recall', href: 'functions/x.md' }));
    assert.deepEqual(await read(), { status: 'incomplete', observed: true, reason: 'invalid_records' });
    await writeFile(join(memoryRoot, '.usage.jsonl'), '');
    assert.deepEqual(await read(), { status: 'observed' });
    await writeFile(join(memoryRoot, '.usage', 'archive', '2025-01.jsonl'), '{broken\n');
    assert.deepEqual(await read(), { status: 'incomplete', observed: true, reason: 'invalid_records' });
    await mkdir(join(memoryRoot, '.usage', '2025-02.jsonl'));
    const failure = await read();
    assert.equal(failure.status, 'error');
    assert.equal(failure.observed, true);
    assert.notEqual(failure.reason, 'no_recall_evidence');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('automatic patrol exposes report write failures for no input and normal input', async () => {
  for (const principles of [[], [{ id: 'example', refs: 0 }]]) {
    const root = await mkdtemp(join(tmpdir(), 'cycle-patrol-write-failure-'));
    const memory = join(root, 'memory');
    const storage = join(root, 'storages');
    let dispose;
    try {
      await mkdir(memory);
      await mkdir(storage);
      // A regular file at the report directory forces a real filesystem failure.
      await writeFile(join(storage, 'mind-patrol'), 'blocked');
      const ctx = { logger: () => ({ info() {}, warn() {}, error() {} }), provide() {}, set() {},
        on(event, fn) { if (event === 'dispose') dispose = fn; }, tools: { register: () => () => {} } };
      apply(ctx, { storageDir: storage, patrol: { enabled: true, principles, memoryRoot: memory,
        pendingAxiomCandidates: () => null } }, { loadDefineTool: () => (s) => s });
      let metrics;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        metrics = await createRuntime({ storageDir: storage }).metrics();
        if (metrics.patrol_facts.weekly?.startsWith('error:') && metrics.patrol_facts.weekly.includes(storage)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.match(metrics.patrol_facts.weekly, /report write failed/);
      assert.match(metrics.patrol_facts.error, /weekly:.*report write failed/);
      if (!principles.length) assert.match(metrics.patrol_facts.error, /no_input/);
      assert.equal(metrics.last_patrol.weekly, 'never');
      assert.equal(await readFile(join(storage, 'mind-patrol'), 'utf8'), 'blocked');
    } finally {
      dispose?.();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('runtime preserves the patrol error when its failure report cannot be written', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cycle-patrol-double-failure-'));
  try {
    await writeFile(join(root, 'mind-patrol'), 'blocked');
    const input = { get principles() { throw new Error('principles unavailable'); } };
    const result = await createRuntime({ storageDir: root }).patrol('weekly', input);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'principles unavailable');
    assert.equal(result.report_ok, false);
    assert.ok(result.report_error);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('recent legacy weekly report catches up once while quarterly keeps its cadence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cycle-patrol-upgrade-'));
  const memory = join(root, 'memory');
  const storage = join(root, 'storages');
  let dispose;
  try {
    await mkdir(memory);
    await mkdir(storage);
    const at = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const weekly = { kind: 'weekly', at, ok: true, findings: [] };
    const quarterly = { kind: 'quarterly', at, ok: true, findings: [] };
    assert.equal((await writePatrolReport(storage, weekly)).ok, true);
    assert.equal((await writePatrolReport(storage, quarterly)).ok, true);
    const ctx = { logger: () => ({ info() {}, warn() {}, error() {} }), provide() {}, set() {},
      on(event, fn) { if (event === 'dispose') dispose = fn; }, tools: { register: () => () => {} } };
    const config = { storageDir: storage, patrol: { enabled: true, principles: [], memoryRoot: memory,
      pendingAxiomCandidates: () => null } };
    apply(ctx, config, { loadDefineTool: () => (s) => s });
    let report;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      report = await readLatestPatrolReport(storage, 'weekly');
      if (report?.cycle_coverage) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(report?.error, 'no_input');
    assert.ok(report.cycle_coverage.memory);
    assert.deepEqual(await readLatestPatrolReport(storage, 'quarterly'), quarterly);
    dispose?.();
    apply(ctx, config, { loadDefineTool: () => (s) => s });
    let metrics;
    const retryDeadline = Date.now() + 5000;
    while (Date.now() < retryDeadline) {
      metrics = await createRuntime({ storageDir: storage }).metrics();
      if (metrics.patrol_facts.weekly === 'skipped_not_due' && metrics.patrol_facts.quarterly === 'skipped_not_due') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(metrics.patrol_facts.weekly, 'skipped_not_due');
    assert.equal(metrics.patrol_facts.quarterly, 'skipped_not_due');
    assert.deepEqual(await readLatestPatrolReport(storage, 'weekly'), report);
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('automatic patrol derives the memory root when no override is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cycle-default-root-'));
  const storage = join(root, 'storages');
  const memory = join(root, 'memory');
  let dispose;
  try {
    await mkdir(storage, { recursive: true });
    await mkdir(memory);
    await writeFile(join(memory, 'MEMORY.md'), '# Default root\n');
    const ctx = { logger: () => ({ info() {}, warn() {}, error() {} }), provide() {}, set() {},
      on(event, fn) { if (event === 'dispose') dispose = fn; }, tools: { register: () => () => {} } };
    apply(ctx, { storageDir: storage, patrol: { enabled: true, principles: [], pendingAxiomCandidates: () => null } },
      { loadDefineTool: () => (s) => s });
    let report;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      report = await readLatestPatrolReport(storage, 'weekly');
      if (report?.cycle_coverage) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(report?.cycle_coverage?.memory?.index?.status, 'observed');
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});

test('automatic startup patrol persists coverage even without principle input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cycle-patrol-'));
  const memory = join(root, 'memory');
  const storage = join(root, 'storages');
  let dispose;
  try {
    await mkdir(memory);
    await mkdir(storage);
    await writeFile(join(memory, '.write-ledger.jsonl'), row({ tool: 'memory-manager', key: 'functions/x.md', hash: 'abc' }));
    await writeFile(join(memory, 'MEMORY.md'), '# Index\n');
    await writeFile(join(memory, '.usage.jsonl'), row({ kind: 'recall', href: 'functions/x.md' }));
    await writeFile(join(storage, 'mind-valves.jsonl'), row({ gate: 'up', outcome: 'admitted' }));
    const ctx = { logger: () => ({ info() {}, warn() {}, error() {} }), provide() {}, set() {},
      on(event, fn) { if (event === 'dispose') dispose = fn; }, tools: { register: () => () => {} } };
    apply(ctx, { storageDir: storage, patrol: { enabled: true, principles: [], memoryRoot: memory,
      pendingAxiomCandidates: () => null } }, { loadDefineTool: () => (s) => s });
    let report;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      report = await readLatestPatrolReport(storage, 'weekly');
      if (report?.cycle_coverage) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(report?.error, 'no_input');
    const coverage = report.cycle_coverage;
    assert.equal(coverage.memory.distillation.status, 'unknown');
    assert.equal(coverage.memory.distillation.tracked_function_write_observed, true);
    assert.equal(coverage.memory.recall.status, 'observed');
    assert.equal(coverage.governance.decisions.status, 'observed');
    assert.equal(coverage.cross_step_correlation.status, 'unknown');
    assert.equal(coverage.micro_execution.outcome.status, 'unknown');
    assert.equal(await readFile(join(memory, 'MEMORY.md'), 'utf8'), '# Index\n');
  } finally {
    dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});
