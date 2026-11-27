import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../index.js';
import { appendDecision, GOVERNANCE_LEDGER_MAX_BYTES as MAX } from '../src/store.js';

const key = 'sample@2026-11-01T00:00:00Z';
const history = { version: 1, records: { sample: { entries: [{ causal_type: 'cyclic', signal_type: 'ineffective', achieved: false, baseline: true, at: '2026-11-01T00:00:00Z' }] } } };
const existing = JSON.stringify({ gate: 'clis_nomination', candidate_id: key }) + '\n';

async function sandbox(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'valves-clis-read-'));
  try {
    await writeFile(join(dir, 'clis-history.json'), JSON.stringify(history));
    await fn(createRuntime({ storageDir: dir }), join(dir, 'mind-valves.jsonl'));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('missing ledger accepts nominations', async () => sandbox(async (rt) => {
  const result = await rt.clisTrace();
  assert.equal(result.ledger_read.status, 'missing');
  assert.equal(result.newly_recorded, 1);
  assert.equal(result.ledger_write.status, 'appended');
  assert.ok((await readFile(join(rt.storageDir, 'mind-valves.jsonl'), 'utf8')).includes(key));
}));

test('complete ledger deduplicates an existing key on replay', async () => sandbox(async (rt, path) => {
  await writeFile(path, existing);
  for (let i = 0; i < 2; i++) {
    const result = await rt.clisTrace();
    assert.equal(result.ledger_read.status, 'complete');
    assert.equal(result.newly_recorded, 0);
  }
  assert.equal(await readFile(path, 'utf8'), existing);
}));

test('corrupt and oversized ledgers stop before any nomination write', async () => sandbox(async (rt, path) => {
  for (const [content, status] of [[existing + '{bad\n', 'corrupt'], [existing + ' '.repeat(MAX), 'truncated'], [Buffer.from([0xff]), 'invalid_utf8']]) {
    await writeFile(path, content);
    const before = await readFile(path);
    const result = await rt.clisTrace();
    assert.equal(result.error, 'ledger_incomplete');
    assert.equal(result.ledger_read.status, status);
    assert.equal(result.ledger_read.complete, false);
    assert.equal(result.ledger_write.status, 'not_attempted');
    assert.equal('newly_recorded' in result, false);
    assert.deepEqual(await readFile(path), before);
  }
}));

test('partial append and lost receipt are reported without claiming completion', async () => sandbox(async (rt, path) => {
  const second = { ...history.records.sample.entries[0], at: '2026-11-02T00:00:00Z' };
  await writeFile(join(rt.storageDir, 'clis-history.json'), JSON.stringify({ version: 1, records: { sample: { entries: [history.records.sample.entries[0], second] } } }));
  let calls = 0;
  const failing = createRuntime({ storageDir: rt.storageDir, clisTraceAppendDecision: async (dir, row) => {
    calls++;
    assert.equal(await appendDecision(dir, row), true);
    return calls === 1;
  } });
  const result = await failing.clisTrace();
  assert.equal(result.error, 'ledger_write_failed_or_unconfirmed');
  assert.equal(result.ledger_write.confirmed_appends, 1);
  assert.equal(result.ledger_write.candidate_id, 'sample@2026-11-02T00:00:00Z');
  assert.equal('newly_recorded' in result, false);
  assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 2);
  const replay = await rt.clisTrace();
  assert.equal(replay.newly_recorded, 0);
  assert.equal((await readFile(path, 'utf8')).trim().split('\n').length, 2);
}));

test('append failure is reported when the ledger becomes a directory', async () => sandbox(async (rt, path) => {
  const injected = createRuntime({ storageDir: rt.storageDir, clisTraceAppendDecision: async (dir, row) => {
    await mkdir(path);
    return appendDecision(dir, row);
  } });
  const result = await injected.clisTrace();
  assert.equal(result.error, 'ledger_write_failed_or_unconfirmed');
  assert.equal(result.ledger_write.confirmed_appends, 0);
  assert.equal('newly_recorded' in result, false);
}));

test('a directory at the ledger path is reported as unreadable', async () => sandbox(async (rt, path) => {
  await mkdir(path);
  const result = await rt.clisTrace();
  assert.equal(result.error, 'ledger_unreadable');
  assert.equal(result.ledger_read.status, 'unreadable');
  assert.equal(result.ledger_write.status, 'not_attempted');
  assert.equal('newly_recorded' in result, false);
}));
