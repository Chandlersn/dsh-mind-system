import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, createRuntime } from '../index.js';

/**
 * A patrol that RAN must leave a trace, not return to null.
 *
 * The skip branches were each given a reason (`skipped_not_due`,
 * `skipped_no_principles`) precisely so "nothing was checked" could not read as
 * "checked and clean". The success path kept writing nothing, which left `null`
 * meaning both "this run completed" and "the timer never fired" — the same
 * indistinction, arriving from the other side.
 *
 * The findings count is asserted as a NUMBER, not just a shape. The first
 * version of this file seeded a patrol that produced zero findings, so a
 * mutation hardcoding `ran:0 findings` passed, and dropping the quarterly
 * assignment passed too — a weak test reads as coverage and is not.
 */

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'patrol-trace-'));
  mkdirSync(join(dir, 'memory'), { recursive: true });
  return dir;
}

const ctxOf = () => ({
  logger: () => ({ info() {}, warn() {}, error() {} }),
  provide() {}, set() {}, on() {}, get: () => null,
  tools: { register: () => () => {} },
});

async function settle(ms = 700) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Seed the decision ledger with `n` rows carrying explicit principle_refs, so
 * refsRowsForPatrol clears MIN_REFS_ROWS (10) and a zero-reference principle
 * becomes a REPORTED finding rather than a counted-only one.
 */
function seedRefsLedger(dir, n) {
  const lines = Array.from({ length: n }, (_, i) => JSON.stringify({
    t: new Date().toISOString(),
    gate: 'downward_L2_L1',
    direction: 'down',
    outcome: 'admitted',
    action: 'concretize',
    origin: 'daily',
    principle_refs: ['test-principle'],
    seq: i,
  }));
  writeFileSync(join(dir, 'mind-valves.jsonl'), lines.join('\n') + '\n', 'utf8');
}

test('a weekly patrol that ran reports its actual findings count', async () => {
  const dir = sandbox();
  try {
    seedRefsLedger(dir, 12);
    apply(ctxOf(), {
      storageDir: dir,
      patrol: {
        enabled: true,
        memoryRoot: join(dir, 'memory'),
        pendingAxiomCandidates: () => null,
        // refs defaults to 0, so with the ledger sufficient this yields one
        // zero_reference finding — the trace must say 1, not merely "ran".
        principles: [{ id: 'test-principle', statement: 'a principle under test', refs: 0 }],
      },
    }, { loadDefineTool: () => (s) => s });
    await settle();
    const m = await createRuntime({ storageDir: dir }).metrics();
    assert.ok(m.patrol_facts.weekly, 'a completed patrol must not report null');
    assert.equal(m.patrol_facts.weekly, 'ran:1 findings', `actual: ${m.patrol_facts.weekly}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the weekly trace tracks the finding count, it is not a constant', async () => {
  const dir = sandbox();
  try {
    seedRefsLedger(dir, 12);
    apply(ctxOf(), {
      storageDir: dir,
      patrol: {
        enabled: true,
        memoryRoot: join(dir, 'memory'),
        pendingAxiomCandidates: () => null,
        principles: [
          { id: 'p-one', statement: 'first', refs: 0 },
          { id: 'p-two', statement: 'second', refs: 0 },
          { id: 'p-three', statement: 'third', refs: 0 },
        ],
      },
    }, { loadDefineTool: () => (s) => s });
    await settle();
    const m = await createRuntime({ storageDir: dir }).metrics();
    // Three zero-reference principles => ran:3. A hardcoded `ran:0` cannot pass.
    assert.equal(m.patrol_facts.weekly, 'ran:3 findings', `actual: ${m.patrol_facts.weekly}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a quarterly patrol that ran leaves its own trace', async () => {
  const dir = sandbox();
  try {
    // dao has one entry; functions/ and insights/ are absent => two empty_layer
    // findings. The quarterly branch returns early, so it needs its own check:
    // dropping only the quarterly assignment must not stay invisible.
    mkdirSync(join(dir, 'memory', 'dao'), { recursive: true });
    writeFileSync(join(dir, 'memory', 'dao', 'one.md'), '# one\n', 'utf8');
    apply(ctxOf(), {
      storageDir: dir,
      patrol: {
        enabled: true,
        memoryRoot: join(dir, 'memory'),
        pendingAxiomCandidates: () => null,
        principles: [{ id: 'test-principle', statement: 'x', refs: 0 }],
      },
    }, { loadDefineTool: () => (s) => s });
    await settle(900);
    const m = await createRuntime({ storageDir: dir }).metrics();
    assert.ok(m.patrol_facts.quarterly, 'quarterly run must leave a trace');
    assert.equal(m.patrol_facts.quarterly, 'ran:2 findings', `actual: ${m.patrol_facts.quarterly}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skip reasons and the run trace are distinguishable', async () => {
  const dir = sandbox();
  try {
    // No principles source at all on an empty memory root: this is the no_input
    // path, which must NOT read like a completed run.
    apply(ctxOf(), {
      storageDir: dir,
      patrol: { enabled: true, memoryRoot: join(dir, 'memory'), pendingAxiomCandidates: () => null },
    }, { loadDefineTool: () => (s) => s });
    await settle();
    const m = await createRuntime({ storageDir: dir }).metrics();
    assert.notEqual(m.patrol_facts.weekly, null, 'a skip must also leave a reason');
    assert.doesNotMatch(m.patrol_facts.weekly, /^ran:/, `a skip must not claim a run: ${m.patrol_facts.weekly}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
