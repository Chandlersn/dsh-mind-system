import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHost } from './helpers/host.js';
import { RuntimeStore } from '../src/store.js';
import * as hostEntry from '../src/host-plugin.js';

test('host reports bounded current bound statuses without legacy attribution', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'summary-'));
  writeFileSync(join(host.storage, 'input.txt'), 'input');
  writeFileSync(join(host.storage, 'occupied.txt'), 'existing');
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir, workspaceRoot: host.storage, scopeRef: 'summary-scope' }).await();
  const db = new DatabaseSync(join(stateDir, 'runtime.sqlite'));
  try {
    const agent = await host.agent('summary-caller');
    const base = { goal: 'Write output', inputs: { inputFile: 'input.txt' },
      recipe: { recipeId: 'summary', tool: 'runtime_write_text', effect: 'reversible_write',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } },
        arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'ok\n', createOnly: true } } };
    for (const [taskId, outputFile, origin, expected] of [
      ['a-one', 'one.txt', 'verification', 'completed'], ['b-two', 'two.txt', 'verification', 'completed'],
      ['c-unknown', 'three.txt', undefined, 'completed'], ['d-waiting', 'four.txt', 'verification', 'waiting_analysis'],
    ]) {
      const args = { ...base, taskId, inputs: { ...base.inputs, outputFile }, ...(origin ? { origin } : {}),
        ...(taskId === 'd-waiting' ? { recipe: { ...base.recipe, recipeId: 'waiting', verifier: { primitive: 'line_set', parameters: { expectedLines: ['different'] } } } } : {}) };
      const result = await host.execute('runtime_execute', { agent, arguments: args });
      assert.equal(result.value.status, expected);
    }
    const legacy = new RuntimeStore(join(stateDir, 'runtime.sqlite'));
    try { legacy.createRun({ taskId: 'legacy', recipeId: 'summary', recipeVersion: '1', goal: 'Legacy', scopeRef: 'summary-scope', workspaceRoot: host.storage, inputs: {}, deadlineAt: Date.now() + 60000 }); }
    finally { legacy.close(); }
    const get = async (bindingLimit) => (await host.execute('runtime_recipes', { agent, arguments: { minVerifiedRuns: 0, bindingLimit } })).value.bindingSummary;
    const summary = await get(100);
    assert.equal(summary.coverage, 'available');
    assert.equal(summary.scanned, 4);
    assert.equal(summary.truncated, false);
    assert.equal(summary.basis.independentGoalProof, false);
    assert.equal(summary.basis.productionVerification, false);
    assert.deepEqual(summary.groups, [
      { recipeId: 'summary', recipeVersion: '1', origins: { verification: { completed: 2 }, unknown: { completed: 1 } } },
      { recipeId: 'waiting', recipeVersion: '1', origins: { verification: { waiting_analysis: 1 } } },
    ]);
    const page = async (bindingCursor) => (await host.execute('runtime_recipes', { agent, arguments: { minVerifiedRuns: 0, bindingLimit: 2, bindingCursor } })).value.bindingSummary;
    const firstPage = await page('');
    assert.equal(firstPage.scanned, 2);
    assert.equal(firstPage.truncated, true);
    assert.deepEqual(firstPage.observations.map((row) => row.taskId), ['a-one', 'b-two']);
    const secondPage = await page(firstPage.nextCursor);
    assert.deepEqual(secondPage.observations.map((row) => row.taskId), ['c-unknown', 'd-waiting']);
    assert.equal(secondPage.rangeExhausted, true);
    assert.equal(secondPage.nextCursor, null);
    assert.equal((await page(firstPage.nextCursor)).observations.length, 2);
    const limited = await get(2);
    assert.equal(limited.scanned, 2);
    assert.equal(limited.truncated, true);
    assert.equal(limited.groups[0].origins.verification.completed, 2);
    assert.equal((await get(4)).truncated, false);
    db.exec('DROP TRIGGER recipe_run_bindings_no_update');
    db.prepare('UPDATE recipe_run_bindings SET origin_json = ? WHERE task_id = ?').run('{}', 'a-one');
    const corrupt = await get(100);
    assert.equal(corrupt.coverage, 'partial_unavailable');
    assert.equal(corrupt.unavailable, 1);
    assert.equal(corrupt.groups[0].origins.verification.completed, 1);
    db.exec("CREATE TRIGGER recipe_run_bindings_no_update BEFORE UPDATE ON recipe_run_bindings BEGIN SELECT RAISE(ABORT, 'Recipe run bindings are immutable'); END");
    const insertRun = db.prepare("INSERT INTO runs (task_id, task_json, status, version, created_at, updated_at) SELECT ?, json_set(task_json, '$.taskId', ?), status, version, created_at, updated_at FROM runs WHERE task_id = 'b-two'");
    const insertBinding = db.prepare("INSERT INTO recipe_run_bindings SELECT ?, recipe_id, recipe_version, identity_json, origin_json FROM recipe_run_bindings WHERE task_id = 'b-two'");
    for (let i = 0; i < 101; i++) { const id = `bulk-${i}`; insertRun.run(id, id); insertBinding.run(id); }
    const largeFirst = (await host.execute('runtime_recipes', { agent, arguments: { bindingLimit: 100, bindingCursor: '' } })).value.bindingSummary;
    assert.equal(largeFirst.scanned, 100);
    assert.equal(largeFirst.truncated, true);
    const largeLast = (await host.execute('runtime_recipes', { agent, arguments: { bindingLimit: 100, bindingCursor: largeFirst.nextCursor } })).value.bindingSummary;
    assert.equal(largeLast.scanned, 5);
    assert.equal(largeLast.rangeExhausted, true);
  } finally { db.close(); await fiber.dispose(); }
});
