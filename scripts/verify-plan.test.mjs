import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixture = (plan) => {
  const root = mkdtempSync(join(tmpdir(), 'verify-plan-'));
  try {
    mkdirSync(join(root, 'scripts'));
    copyFileSync(new URL('./verify-plan.mjs', import.meta.url), join(root, 'scripts', 'verify-plan.mjs'));
    writeFileSync(join(root, 'UPGRADE-PLAN.md'), plan);
    return spawnSync(process.execPath, [join(root, 'scripts', 'verify-plan.mjs')], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const validPlan = '# Plan\n\n## Execution\n\nRun an independent check.\n';

test('accepts a future-facing plan without progress tables', () => {
  const result = fixture(validPlan);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /plan-check: ALL PASS/);
});

test('rejects progress tables, checkboxes, and emoji markers', () => {
  for (const marker of ['| Order | Status |', '- [ ] pending', '- [x] completed', '* [X] completed', '✅', '🔶', '⬜']) {
    const result = fixture(`${validPlan}\n${marker}\n`);
    assert.equal(result.status, 1, `Expected refusal of ${marker}`);
    assert.match(result.stderr, /progress tables and status markers/);
  }
});

test('rejects a plan without the required title or iteration action', () => {
  for (const plan of ['## Execution\n\nTake action\n', '# Plan\n\n## Execution\n']) {
    const result = fixture(plan);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /plan title and an iteration with an action/);
  }
});
