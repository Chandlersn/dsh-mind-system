import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../index.js';
import { GOVERNANCE_LEDGER_MAX_BYTES as MAX, readDecisions, readGovernanceDecisions } from '../src/store.js';

async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'valves-governance-read-'));
  try { await fn(dir, join(dir, 'mind-valves.jsonl')); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

const row = JSON.stringify({ gate: 'downward', outcome: 'admitted', origin: 'daily', principle_refs: [] }) + '\n';
const principles = [{ principle_id: 'p', anti_examples: [
  { source: 'a', trace_ref: '1' }, { source: 'b', trace_ref: '2' }, { source: 'a', trace_ref: '3' },
] }];

test('governance reader distinguishes missing, empty and an exact byte limit', async () => sandbox(async (dir, path) => {
  assert.equal((await readGovernanceDecisions(dir)).status, 'missing');
  await writeFile(path, '');
  assert.equal((await readGovernanceDecisions(dir)).status, 'complete');
  await writeFile(path, ' '.repeat(MAX));
  const result = await readGovernanceDecisions(dir);
  assert.equal(result.complete, true);
  assert.equal(result.bytes_read, MAX);
}));

test('truncated and corrupt reads cannot produce verdicts or proposals', async () => sandbox(async (dir, path) => {
  const rt = createRuntime({ storageDir: dir });
  for (const [text, status] of [[row.repeat(20) + '{bad\n', 'corrupt'], [row.repeat(20) + ' '.repeat(MAX), 'truncated']]) {
    await writeFile(path, text);
    const result = await rt.govern({ principles });
    assert.equal(result.error, 'ledger_incomplete');
    assert.equal(result.ledger_read.status, status);
    assert.deepEqual(result.principle_reports, []);
    assert.deepEqual(result.redefinition_proposals, []);
    assert.equal(result.human_gate_required, true);
    assert.ok(result.ledger_read.bytes_read <= MAX + 1);
    if (status === 'corrupt') {
      assert.equal(result.ledger_read.corrupt_lines, 1);
      assert.equal((await readDecisions(dir)).length, 20);
    } else assert.equal(result.ledger_read.truncated, true);
  }
}));

test('read failure is distinct from an empty ledger', async () => sandbox(async (dir, path) => {
  await mkdir(path);
  const result = await createRuntime({ storageDir: dir }).govern({ principles });
  assert.equal(result.error, 'ledger_unreadable');
  assert.equal(result.ledger_read.status, 'unreadable');
  assert.deepEqual(result.redefinition_proposals, []);
}));

test('a complete ledger retains normal governance behavior', async () => sandbox(async (dir, path) => {
  await writeFile(path, row.repeat(20));
  const result = await createRuntime({ storageDir: dir }).govern({ principles });
  assert.equal(result.ledger_read.complete, true);
  assert.equal(result.ledger_write.status, 'appended');
  assert.equal(result.principle_reports[0].status, 'invalid');
  assert.equal(result.redefinition_proposals.length, 1);
}));

test('append failure is reported independently and retains the assessment', async () => sandbox(async (dir, path) => {
  await writeFile(path, row.repeat(20));
  const input = { principles };
  let injected = false;
  Object.defineProperty(input, 'origin', {
    enumerable: true,
    get() {
      if (!injected) {
        rmSync(path, { force: true });
        mkdirSync(path, { recursive: true });
        injected = true;
      }
      return 'daily';
    },
  });
  const result = await createRuntime({ storageDir: dir }).govern(input);
  assert.equal(result.ledger_read.complete, true);
  assert.equal(result.ledger_write.status, 'failed_or_unconfirmed');
  assert.equal(result.principle_reports[0].status, 'invalid');
  assert.equal(result.redefinition_proposals.length, 1);
}));
