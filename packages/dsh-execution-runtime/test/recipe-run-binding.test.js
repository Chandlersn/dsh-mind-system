import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/store.js';
import { RuntimeScheduler } from '../src/scheduler.js';
import { createRecipeLibrary } from '../src/recipe-library.js';
import { buildRecipeFromSpec, recipeIdentity } from '../src/recipe-factory.js';

const spec = { recipeId: 'sample', tool: 'reader', effect: 'read', verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } } };
const effects = { reader: 'read' };
const identity = recipeIdentity(buildRecipeFromSpec(spec, { toolEffects: effects }));
const binding = { recipeId: 'sample', version: '1', identity };
const task = (taskId, extra = {}) => ({ taskId, recipeId: 'sample', recipeVersion: '1', goal: 'Observe', scopeRef: 'scope', workspaceRoot: process.cwd(), inputs: {}, deadlineAt: Date.now() + 60000, ...extra });

test('migration keeps existing tasks unbound across reopen', () => {
  const root = mkdtempSync(join(tmpdir(), 'recipe-binding-'));
  const file = join(root, 'state.sqlite');
  let store = new RuntimeStore(file);
  try {
    store.createRun(task('legacy'));
    store.withDatabase((db) => db.exec('DROP TABLE recipe_run_bindings'));
    store.close();
    store = new RuntimeStore(file);
    assert.equal(store.getRecipeOutcome('legacy').coverage, 'unbound');
    assert.equal(store.getRun('legacy').status, 'running');
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('future bindings are atomic, immutable, current and distinguish declared origin', async () => {
  const store = new RuntimeStore(':memory:');
  try {
    store.createRun(task('legacy'));
    assert.equal(store.getRecipeOutcome('legacy').coverage, 'unbound');
    assert.throws(() => store.createRun(task('missing'), { recipeBinding: binding }), { code: 'recipe_identity_unverifiable' });
    assert.throws(() => store.getRun('missing'), { code: 'run_not_found' });
    const separate = new RuntimeStore(':memory:');
    try {
      separate.withDatabase((db) => createRecipeLibrary({ db })).record(spec, { toolEffects: effects });
      assert.throws(() => store.createRun(task('separate'), { recipeBinding: binding }), { code: 'recipe_identity_unverifiable' });
      assert.throws(() => store.getRun('separate'), { code: 'run_not_found' });
    } finally { separate.close(); }
    const library = store.withDatabase((db) => createRecipeLibrary({ db }));
    library.record(spec, { toolEffects: effects });
    for (const column of ['identity_json', 'spec_json']) {
      store.withDatabase((db) => db.exec(`UPDATE recipe_library SET ${column} = CAST(CAST(${column} AS BLOB) || x'00626164' AS TEXT)`));
      assert.throws(() => store.createRun(task(`corrupt-${column}`), { recipeBinding: binding }), { code: 'recipe_identity_unverifiable' });
      assert.throws(() => store.getRun(`corrupt-${column}`), { code: 'run_not_found' });
      store.withDatabase((db) => db.exec(`UPDATE recipe_library SET ${column} = CAST(substr(CAST(${column} AS BLOB), 1, length(CAST(${column} AS BLOB)) - 4) AS TEXT)`));
    }
    assert.throws(() => store.createRun(task('bad'), { recipeBinding: { ...binding, identity: '{}' } }), { code: 'recipe_identity_unverifiable' });
    store.withDatabase((db) => db.exec("CREATE TRIGGER reject_binding BEFORE INSERT ON recipe_run_bindings BEGIN SELECT RAISE(ABORT, 'reject'); END"));
    assert.throws(() => store.createRun(task('rollback'), { recipeBinding: binding }));
    assert.throws(() => store.getRun('rollback'), { code: 'run_not_found' });
    store.withDatabase((db) => db.exec('DROP TRIGGER reject_binding'));
    store.createRun(task('bound', { origin: 'daily' }), { recipeBinding: binding });
    assert.deepEqual(store.getRecipeOutcome('bound').origin, { kind: 'declared', value: 'daily' });
    assert.throws(() => store.createRun(task('bound'), { recipeBinding: binding }));
    assert.throws(() => store.withDatabase((db) => db.exec("UPDATE recipe_run_bindings SET recipe_id = 'x'")));
    const run = store.getRun('bound');
    store.stopRun('bound', 'waiting_analysis', 'pending', { expectedVersion: run.version });
    const current = store.getRecipeOutcome('bound');
    assert.equal(current.status, 'waiting_analysis');
    assert.equal(current.version, store.getRun('bound').version);
    assert.equal(current.independentGoalProof, false);
    assert.throws(() => store.startRepair('bound', 'analysis', { expectedVersion: current.version, signature: 'signature' }),
      { code: 'recipe_recovery_unavailable' });
    assert.throws(() => store.resumeRun('bound', { expectedVersion: current.version, requireEnvironment: false }),
      { code: 'recipe_recovery_unavailable' });
    assert.equal(store.getRun('bound').version, current.version);
    const scheduler = new RuntimeScheduler({ store, recipes: [], executor: { execute() { throw new Error('unexpected dispatch'); } },
      tools: {}, validateArguments() {} });
    await assert.rejects(() => scheduler.repair('bound', 'analysis', {}), { code: 'recipe_recovery_unavailable' });
    assert.equal(store.getRun('bound').version, current.version);
    store.createRun(task('unknown'), { recipeBinding: binding });
    assert.deepEqual(store.getRecipeOutcome('unknown').origin, { kind: 'unknown' });
    store.withDatabase((db) => db.prepare('UPDATE recipe_library SET identity_json = ? WHERE recipe_key = ?').run('{}', 'sample:1'));
    assert.equal(store.getRecipeOutcome('bound').coverage, 'unavailable');
  } finally { store.close(); }
});
