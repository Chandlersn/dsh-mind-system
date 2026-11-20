import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCycleCoverage } from '../src/cycle-coverage.js';

/**
 * One BOM byte must not invalidate a whole ledger.
 *
 * The real incident: two append-only ledgers were once created by a PowerShell
 * `Set-Content`, which wrote a BOM on line 1. Every later row is clean, but
 * `JSON.parse` rejects the first line, and the old code answered "the file is
 * invalid" — discarding 255 readable rows of governance evidence because of one
 * byte. The status the panel shows is derived from that answer, so a working
 * system rendered as "not connected".
 */

const BOM = '\uFEFF';

async function fixture(rows, { bom = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'coverage-'));
  const storageDir = join(root, 'storages');
  const memoryRoot = join(root, 'memory');
  await mkdir(storageDir, { recursive: true });
  await mkdir(join(memoryRoot, '.usage'), { recursive: true });
  const text = (bom ? BOM : '') + rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  await writeFile(join(storageDir, 'mind-valves.jsonl'), text, 'utf8');
  await writeFile(join(memoryRoot, 'MEMORY.md'), '# index\n', 'utf8');
  await writeFile(join(memoryRoot, '.usage', '2026-11.jsonl'),
    (bom ? BOM : '') + JSON.stringify({ kind: 'recall', href: 'insights/a.md', t: new Date().toISOString() }) + '\n', 'utf8');
  await writeFile(join(memoryRoot, '.write-ledger.jsonl'),
    JSON.stringify({ tool: 'memory-manager', key: 'functions/a.md', hash: 'x', t: new Date().toISOString() }) + '\n', 'utf8');
  return { root, storageDir, memoryRoot };
}

const decision = { gate: 'downward_L2_L1', direction: 'down', outcome: 'admitted', t: new Date().toISOString() };

test('a BOM on line 1 does not make the ledger read as invalid', async () => {
  const { root, storageDir, memoryRoot } = await fixture([decision], { bom: true });
  try {
    const cov = await collectCycleCoverage({ storageDir, memoryRoot, getRuntimeStatus: () => null });
    // Before the fix this came back { status: 'incomplete', reason: 'invalid_records' }
    // even though the only unreadable thing was one invisible byte.
    assert.equal(cov.governance.decisions.status, 'observed', JSON.stringify(cov.governance.decisions));
    assert.equal(cov.memory.recall.status, 'observed', JSON.stringify(cov.memory.recall));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a genuinely corrupt row is reported as a count, and clean rows still count', async () => {
  const { root, storageDir, memoryRoot } = await fixture([decision, '{ not json', decision]);
  try {
    const cov = await collectCycleCoverage({ storageDir, memoryRoot, getRuntimeStatus: () => null });
    const d = cov.governance.decisions;
    assert.equal(d.status, 'incomplete');
    assert.equal(d.reason, 'invalid_records');
    // The distinction that matters: observed survives, and the damage is quantified
    // instead of blanket-rejecting the file.
    assert.equal(d.observed, true);
    assert.equal(d.invalid, 1);
    assert.equal(d.rows, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a file whose every row is unreadable is unknown, not observed', async () => {
  const { root, storageDir, memoryRoot } = await fixture(['garbage-one', 'garbage-two']);
  try {
    const cov = await collectCycleCoverage({ storageDir, memoryRoot, getRuntimeStatus: () => null });
    const d = cov.governance.decisions;
    assert.equal(d.status, 'unknown');
    assert.equal(d.reason, 'no_readable_records');
    assert.equal(d.observed, false);
    assert.equal(d.rows, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an array row counts as invalid, not as a record', async () => {
  const { root, storageDir, memoryRoot } = await fixture([[1, 2, 3], decision]);
  try {
    const cov = await collectCycleCoverage({ storageDir, memoryRoot, getRuntimeStatus: () => null });
    assert.equal(cov.governance.decisions.invalid, 1);
    assert.equal(cov.governance.decisions.rows, 1);
    assert.equal(cov.governance.decisions.observed, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a clean ledger reports observed with no invalid count noise', async () => {
  const { root, storageDir, memoryRoot } = await fixture([decision]);
  try {
    const cov = await collectCycleCoverage({ storageDir, memoryRoot, getRuntimeStatus: () => null });
    assert.deepEqual(cov.governance.decisions, { status: 'observed' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
