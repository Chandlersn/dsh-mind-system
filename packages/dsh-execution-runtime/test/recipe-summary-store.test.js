import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/store.js';
import { createRecipeLibrary } from '../src/recipe-library.js';
import { buildRecipeFromSpec, recipeIdentity } from '../src/recipe-factory.js';

test('summary uses one snapshot, rejects nested transactions and mismatched colon identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'recipe-summary-'));
  const file = join(root, 'runtime.sqlite');
  const store = new RuntimeStore(file);
  const other = new DatabaseSync(file);
  try {
    const spec = { recipeId: 'a:b', version: 'c', tool: 'reader', effect: 'read', verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } } };
    const effects = { reader: 'read' };
    const binding = { recipeId: spec.recipeId, version: spec.version, identity: recipeIdentity(buildRecipeFromSpec(spec, { toolEffects: effects })) };
    store.withDatabase((db) => createRecipeLibrary({ db })).record(spec, { toolEffects: effects });
    for (const taskId of ['one', 'two']) store.createRun({ taskId, recipeId: spec.recipeId, recipeVersion: spec.version, goal: 'Read', scopeRef: 'scope', workspaceRoot: process.cwd(), inputs: {}, deadlineAt: Date.now() + 60000 }, { recipeBinding: binding });
    store.withDatabase((db) => { db.exec('BEGIN'); assert.equal(store.summarizeRecipeOutcomes().reason, 'snapshot_transaction_nested'); db.exec('ROLLBACK'); });
    assert.throws(() => store.summarizeRecipeOutcomes({ limit: 0 }), { code: 'invalid_snapshot_limit' });
    assert.throws(() => store.summarizeRecipeOutcomes({ limit: 101 }), { code: 'invalid_snapshot_limit' });
    const original = store.getRecipeOutcome.bind(store);
    let called = false;
    store.getRecipeOutcome = (id) => {
      if (!called) { called = true; other.prepare("UPDATE runs SET status = 'completed' WHERE task_id = 'two'").run(); }
      return original(id);
    };
    const snapshot = store.summarizeRecipeOutcomes();
    assert.equal(snapshot.groups[0].origins.unknown.running, 2);
    assert.equal(store.summarizeRecipeOutcomes().groups[0].origins.unknown.completed, 1);
    other.exec('DROP TRIGGER recipe_run_bindings_no_update');
    other.prepare("UPDATE recipe_run_bindings SET recipe_id = 'a', recipe_version = 'b:c' WHERE task_id = 'one'").run();
    const corrupt = store.summarizeRecipeOutcomes();
    assert.equal(corrupt.coverage, 'partial_unavailable');
    assert.equal(corrupt.unavailable, 1);
    assert.equal(corrupt.groups[0].recipeId, 'a:b');
  } finally { other.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('external SQLite corruption cannot alias identities or produce statuses', async (t) => {
  const cases = [
    ['binding recipe id NUL', "UPDATE recipe_run_bindings SET recipe_id = CAST(CAST(recipe_id AS BLOB) || x'0078' AS TEXT)"],
    ['binding recipe version NUL', "UPDATE recipe_run_bindings SET recipe_version = CAST(CAST(recipe_version AS BLOB) || x'0078' AS TEXT)"],
    ['binding identity NUL', "UPDATE recipe_run_bindings SET identity_json = CAST(CAST(identity_json AS BLOB) || x'0078' AS TEXT)"],
    ['origin JSON NUL', "UPDATE recipe_run_bindings SET origin_json = CAST(CAST(origin_json AS BLOB) || x'0078' AS TEXT)"],
    ['task JSON NUL', "UPDATE runs SET task_json = CAST(CAST(task_json AS BLOB) || x'0078' AS TEXT)"],
    ['status NUL', "UPDATE runs SET status = CAST(CAST(status AS BLOB) || x'0078' AS TEXT)"],
    ['library identity NUL', "UPDATE recipe_library SET identity_json = CAST(CAST(identity_json AS BLOB) || x'0078' AS TEXT)"],
    ['library spec NUL', "UPDATE recipe_library SET spec_json = CAST(CAST(spec_json AS BLOB) || x'0078' AS TEXT)"],
    ['recipe id invalid UTF-8', "UPDATE recipe_run_bindings SET recipe_id = CAST(x'ff' AS TEXT)"],
    ['recipe version invalid UTF-8', "UPDATE recipe_run_bindings SET recipe_version = CAST(x'ff' AS TEXT)"],
    ['identity invalid UTF-8', "UPDATE recipe_run_bindings SET identity_json = CAST(x'ff' AS TEXT)"],
    ['origin invalid UTF-8', "UPDATE recipe_run_bindings SET origin_json = CAST(x'ff' AS TEXT)"],
    ['task invalid UTF-8', "UPDATE runs SET task_json = CAST(x'ff' AS TEXT)"],
    ['status invalid UTF-8', "UPDATE runs SET status = CAST(x'ff' AS TEXT)"],
    ['library identity invalid UTF-8', "UPDATE recipe_library SET identity_json = CAST(x'ff' AS TEXT)"],
    ['library spec invalid UTF-8', "UPDATE recipe_library SET spec_json = CAST(x'ff' AS TEXT)"],
    ['library key NUL', "UPDATE recipe_library SET recipe_key = CAST(CAST(recipe_key AS BLOB) || x'0078' AS TEXT)"],
  ];
  for (const [name, sql] of cases) await t.test(name, () => {
    const root = mkdtempSync(join(tmpdir(), 'recipe-corrupt-'));
    const file = join(root, 'runtime.sqlite');
    const store = new RuntimeStore(file);
    const other = new DatabaseSync(file);
    try {
      const spec = { recipeId: 'recipe', version: '1', tool: 'reader', effect: 'read', verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } } };
      const effects = { reader: 'read' };
      const identity = recipeIdentity(buildRecipeFromSpec(spec, { toolEffects: effects }));
      store.withDatabase((db) => createRecipeLibrary({ db })).record(spec, { toolEffects: effects });
      store.createRun({ taskId: 'a', recipeId: 'recipe', recipeVersion: '1', goal: 'Read', scopeRef: 'scope', workspaceRoot: process.cwd(), inputs: {}, deadlineAt: Date.now() + 60000 }, { recipeBinding: { recipeId: 'recipe', version: '1', identity } });
      assert.equal(store.getRecipeOutcome('a').coverage, 'bound');
      other.exec('DROP TRIGGER recipe_run_bindings_no_update');
      other.exec(sql);
      assert.equal(store.getRecipeOutcome('a').coverage, 'unavailable');
      const summary = store.summarizeRecipeOutcomes();
      assert.equal(summary.coverage, 'partial_unavailable');
      assert.equal(summary.unavailable, 1);
      assert.deepEqual(summary.groups, []);
    } finally { other.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  });
});

test('NUL task identifier cannot alias a valid task in summary or exact lookup', () => {
  const root = mkdtempSync(join(tmpdir(), 'recipe-nul-task-'));
  const file = join(root, 'runtime.sqlite');
  const store = new RuntimeStore(file);
  const other = new DatabaseSync(file);
  try {
    const spec = { recipeId: 'recipe', version: '1', tool: 'reader', effect: 'read', verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } } };
    const effects = { reader: 'read' };
    const identity = recipeIdentity(buildRecipeFromSpec(spec, { toolEffects: effects }));
    store.withDatabase((db) => createRecipeLibrary({ db })).record(spec, { toolEffects: effects });
    store.createRun({ taskId: 'a', recipeId: 'recipe', recipeVersion: '1', goal: 'Read', scopeRef: 'scope', workspaceRoot: process.cwd(), inputs: {}, deadlineAt: Date.now() + 60000 }, { recipeBinding: { recipeId: 'recipe', version: '1', identity } });
    other.exec("INSERT INTO runs (task_id, task_json, status, version, created_at, updated_at) SELECT CAST(x'610078' AS TEXT), task_json, status, version, created_at, updated_at FROM runs WHERE task_id = 'a'");
    other.exec("INSERT INTO recipe_run_bindings SELECT CAST(x'610078' AS TEXT), recipe_id, recipe_version, identity_json, origin_json FROM recipe_run_bindings WHERE task_id = 'a'");
    const summary = store.summarizeRecipeOutcomes();
    assert.equal(summary.coverage, 'partial_unavailable');
    assert.equal(summary.unavailable, 1);
    assert.equal(summary.groups[0].origins.unknown.running, 1);
    assert.equal(store.getRecipeOutcome('a\0x').coverage, 'unavailable');
    assert.equal(store.getRecipeOutcome('a').coverage, 'bound');
  } finally { other.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});
