import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/store.js';
import { createRecipeLibrary } from '../src/recipe-library.js';
import { buildRecipeFromSpec, recipeIdentity } from '../src/recipe-factory.js';
import { createLibraryTool } from '../src/dynamic-tools.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recipe-page-'));
  const file = join(root, 'runtime.sqlite');
  const store = new RuntimeStore(file);
  const other = new DatabaseSync(file);
  const spec = { recipeId: 'r', version: '1', tool: 'reader', effect: 'read', verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } } };
  const effects = { reader: 'read' };
  const identity = recipeIdentity(buildRecipeFromSpec(spec, { toolEffects: effects }));
  const library = store.withDatabase((db) => createRecipeLibrary({ db }));
  library.record(spec, { toolEffects: effects });
  function add(id) { store.createRun({ taskId: id, recipeId: 'r', recipeVersion: '1', goal: 'Read', scopeRef: 'scope', workspaceRoot: process.cwd(), inputs: {}, deadlineAt: Date.now() + 600000 }, { recipeBinding: { recipeId: 'r', version: '1', identity } }); }
  function close() { other.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
  return { store, other, library, add, close };
}

test('pages preserve row membership, report corrupt IDs and re-read status', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 105; i++) f.add(`z${String(i).padStart(3, '0')}`);
    f.other.exec('PRAGMA foreign_keys = OFF');
    f.other.exec("INSERT INTO recipe_run_bindings SELECT CAST(x'7a3030300078' AS TEXT), recipe_id, recipe_version, identity_json, origin_json FROM recipe_run_bindings WHERE task_id='z000'");
    const first = f.store.pageRecipeOutcomes({ limit: 100, cursor: '' });
    assert.equal(first.scanned, 100);
    assert.equal(first.snapshotHighWatermark, '106');
    assert.equal(first.nextCursor, 'v1:106:100');
    f.add('a-new');
    f.other.exec("UPDATE runs SET status='completed' WHERE task_id='z100'");
    const last = f.store.pageRecipeOutcomes({ limit: 100, cursor: first.nextCursor });
    assert.equal(last.scanned, 6);
    assert.equal(last.observations[0].status, 'completed');
    assert.equal(last.observations.at(-1).coverage, 'unavailable');
    assert.equal(last.observations.at(-1).rowid, '106');
    assert.equal(last.unavailable, 1);
    assert.equal(last.rangeExhausted, true);
    assert.equal(last.nextCursor, null);
    assert.equal(last.observations.some((x) => x.taskId === 'a-new'), false);
    assert.equal(last.basis.cursorProvesCompleteness, false);
    assert.equal(last.basis.statusSnapshot, 'per_page');
    assert.equal(last.basis.membership, 'conditional_append_only_no_vacuum_replace_or_explicit_rowid');
    f.other.exec("UPDATE runs SET status='failed' WHERE task_id='z100'");
    assert.equal(f.store.pageRecipeOutcomes({ limit: 100, cursor: first.nextCursor }).observations[0].status, 'failed');
    assert.equal(f.store.pageRecipeOutcomes({ limit: 100, cursor: 'v1:106:104' }).scanned, 2);
    const skipped = f.store.pageRecipeOutcomes({ limit: 100, cursor: 'v1:106:106' });
    assert.equal(skipped.scanned, 0);
    assert.equal(skipped.rangeExhausted, true);
    assert.equal(skipped.basis.cursorProvesCompleteness, false);
  } finally { f.close(); }
});

test('page snapshot is consistent, validates inputs before queries, and refuses nested transactions', async () => {
  const f = fixture();
  try {
    f.add('one'); f.add('two');
    const original = f.store.getRecipeOutcome.bind(f.store);
    let changed = false;
    f.store.getRecipeOutcome = (id) => { if (!changed) { changed = true; f.other.exec("UPDATE runs SET status='completed' WHERE task_id='two'"); } return original(id); };
    assert.deepEqual(f.store.pageRecipeOutcomes({ limit: 2, cursor: '' }).observations.map((x) => x.status), ['running', 'running']);
    assert.equal(f.store.pageRecipeOutcomes({ limit: 2, cursor: '' }).observations[1].status, 'completed');
    for (const cursor of ['v1:01:0', 'v1:-0:0', 'v1:2:3', 'v2:2:1', 'v1:9223372036854775808:1', 'v1:1:-9223372036854775809', 'v1:1:0\n']) assert.throws(() => f.store.pageRecipeOutcomes({ limit: 1, cursor }), { code: 'invalid_binding_cursor' });
    assert.throws(() => f.store.pageRecipeOutcomes({ cursor: '' }), { code: 'invalid_snapshot_limit' });
    f.store.withDatabase((db) => { db.exec('BEGIN'); assert.equal(f.store.pageRecipeOutcomes({ limit: 1, cursor: '' }).reason, 'snapshot_transaction_nested'); db.exec('ROLLBACK'); });
    const tool = createLibraryTool({ library: null, store: f.store });
    await assert.rejects(tool.execute({ bindingLimit: 1, bindingCursor: 'bad' }), { code: 'invalid_binding_cursor' });
    assert.equal((await tool.execute({ bindingLimit: 1, bindingCursor: '' })).available, false);
  } finally { f.close(); }
});

test('signed rowids include negatives and preserve 64-bit precision; exhaustion is unavailable', () => {
  const f = fixture();
  try {
    f.add('a'); f.add('b'); f.add('c');
    f.other.exec('DROP TRIGGER recipe_run_bindings_no_update');
    f.other.exec("UPDATE recipe_run_bindings SET rowid=-1 WHERE task_id='a'; UPDATE recipe_run_bindings SET rowid=0 WHERE task_id='b'; UPDATE recipe_run_bindings SET rowid=9007199254740993 WHERE task_id='c'");
    f.other.exec("CREATE TRIGGER recipe_run_bindings_no_update BEFORE UPDATE ON recipe_run_bindings BEGIN SELECT RAISE(ABORT, 'Recipe run bindings are immutable'); END");
    const first = f.store.pageRecipeOutcomes({ limit: 2, cursor: '' });
    assert.deepEqual(first.observations.map((x) => x.rowid), ['-1', '0']);
    assert.equal(first.nextCursor, 'v1:9007199254740993:0');
    assert.equal(f.store.pageRecipeOutcomes({ limit: 2, cursor: first.nextCursor }).observations[0].rowid, '9007199254740993');
    f.other.exec('DROP TRIGGER recipe_run_bindings_no_update');
    f.other.exec("UPDATE recipe_run_bindings SET rowid=9223372036854775807 WHERE task_id='c'");
    f.other.exec("CREATE TRIGGER recipe_run_bindings_no_update BEFORE UPDATE ON recipe_run_bindings BEGIN SELECT RAISE(ABORT, 'Recipe run bindings are immutable'); END");
    assert.equal(f.store.pageRecipeOutcomes({ limit: 2, cursor: '' }).reason, 'rowid_exhausted');
    f.other.exec('DROP TRIGGER recipe_run_bindings_no_delete');
    assert.equal(f.store.pageRecipeOutcomes({ limit: 2, cursor: '' }).reason, 'membership_environment_unavailable');
  } finally { f.close(); }
});
