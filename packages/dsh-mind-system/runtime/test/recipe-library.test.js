import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore } from '../src/store.js';
import { createRecipeLibrary } from '../src/recipe-library.js';
import { buildRecipeFromSpec } from '../src/recipe-factory.js';

/**
 * The library remembers specifications that worked, so a later task does not have to re-describe them.
 *
 * The risk it introduces is that reuse becomes precedent — "it worked before" quietly replacing acceptance.
 * These tests pin the opposite: a stored entry is data, it still has to pass the same checks, and the
 * counters only move on verified completion.
 */

const toolEffects = { 'runtime.write_text': 'reversible_write' };

const spec = (overrides = {}) => ({
  recipeId: 'sorted-lines', version: '1', tool: 'runtime.write_text', effect: 'reversible_write',
  verifier: { primitive: 'line_set', parameters: { expectedLines: ['a', 'b'] } },
  arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'a\nb\n', createOnly: true },
  ...overrides,
});

function withLibrary(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'recipe-library-'));
  const store = new RuntimeStore(join(root, 'runtime.sqlite'));
  const library = store.withDatabase((db) => createRecipeLibrary({ db }));
  return Promise.resolve(body({ store, library, root })).finally(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
}

test('a recorded specification survives and can be read back as data', async (t) => {
  await withLibrary(t, async ({ library }) => {
    const recorded = library.record(spec(), { goalPattern: 'sort the input lines', toolEffects });
    assert.equal(recorded.created, true);
    assert.equal(recorded.recipeKey, 'sorted-lines:1');
    const read = library.read('sorted-lines:1');
    assert.equal(read.goalPattern, 'sort the input lines');
    assert.equal(read.verifiedRuns, 0);
    // The stored form is the specification, not a recipe object: callbacks cannot survive serialization,
    // and loading code from storage would be a much larger trust surface than loading data.
    assert.equal(typeof read.spec.candidates, 'undefined');
    assert.equal(read.spec.verifier.primitive, 'line_set');
  });
});

test('a specification that cannot build is refused before it reaches the library', async (t) => {
  await withLibrary(t, async ({ library }) => {
    // An unknown primitive means the entry would look usable and then fail at run time.
    assert.throws(() => library.record(spec({ verifier: { primitive: 'always_pass' } }), { toolEffects }),
      { code: 'invalid_recipe_spec' });
    // An effect table is required and must come from the host, not from the stored spec.
    assert.throws(() => library.record(spec(), {}), { code: 'invalid_recipe_spec' });
    assert.equal(library.read('sorted-lines:1'), null);
  });
});

test('re-recording refreshes the goal but keeps the usage history', async (t) => {
  await withLibrary(t, async ({ library }) => {
    library.record(spec(), { goalPattern: 'first wording', toolEffects });
    library.recordOutcome({ recipeKey: 'sorted-lines:1', status: 'completed', taskId: 'task-a' });
    const second = library.record(spec(), { goalPattern: 'second wording', toolEffects });
    assert.equal(second.created, false, 'The same key is an update, not a new entry.');
    const read = library.read('sorted-lines:1');
    assert.equal(read.goalPattern, 'second wording');
    assert.equal(read.verifiedRuns, 1, 'The history belongs to the identity, not to one submission.');
  });
});

test('only verified completion counts as success', async (t) => {
  await withLibrary(t, async ({ library }) => {
    library.record(spec(), { toolEffects });
    // Everything that is not a verified completion must count against the recipe, including the states
    // that merely mean "nothing was proven".
    for (const status of ['waiting_analysis', 'blocked', 'reconciling', 'failed']) {
      library.recordOutcome({ recipeKey: 'sorted-lines:1', status, taskId: `task-${status}` });
    }
    const failed = library.read('sorted-lines:1');
    assert.equal(failed.verifiedRuns, 0);
    assert.equal(failed.failedRuns, 4);

    library.recordOutcome({ recipeKey: 'sorted-lines:1', status: 'completed', taskId: 'task-ok' });
    const after = library.read('sorted-lines:1');
    assert.equal(after.verifiedRuns, 1);
    assert.equal(after.failedRuns, 4, 'A later success does not erase earlier failures.');
  });
});

test('an outcome for an unrecorded recipe is refused rather than invented', async (t) => {
  await withLibrary(t, async ({ library }) => {
    assert.throws(() => library.recordOutcome({ recipeKey: 'never-recorded:1', status: 'completed',
      taskId: 't' }), { code: 'recipe_not_in_library' });
  });
});

test('listing is ordered by demonstrated success, and the threshold is honoured', async (t) => {
  await withLibrary(t, async ({ library }) => {
    library.record(spec({ recipeId: 'alpha' }), { toolEffects });
    library.record(spec({ recipeId: 'beta' }), { toolEffects });
    library.record(spec({ recipeId: 'gamma' }), { toolEffects });
    library.recordOutcome({ recipeKey: 'beta:1', status: 'completed', taskId: 't1' });
    library.recordOutcome({ recipeKey: 'beta:1', status: 'completed', taskId: 't2' });
    library.recordOutcome({ recipeKey: 'alpha:1', status: 'completed', taskId: 't3' });
    // gamma never succeeded, so it must not appear once a bar is set.
    const oneSuccess = library.list({ minVerifiedRuns: 1 });
    assert.deepEqual(oneSuccess.map((item) => item.recipeKey), ['beta:1', 'alpha:1']);
    const twoSuccesses = library.list({ minVerifiedRuns: 2 });
    assert.deepEqual(twoSuccesses.map((item) => item.recipeKey), ['beta:1']);
    // A never-successful recipe is still recorded; it just does not clear the bar.
    assert.equal(library.read('gamma:1').verifiedRuns, 0);
  });
});

test('suggestion returns candidates and never runs one', async (t) => {
  await withLibrary(t, async ({ library }) => {
    library.record(spec({ recipeId: 'sort-lines' }), { goalPattern: 'sort the input lines', toolEffects });
    library.record(spec({ recipeId: 'totals' }), { goalPattern: 'sum the totals column', toolEffects });
    library.recordOutcome({ recipeKey: 'sort-lines:1', status: 'completed', taskId: 't1' });

    const matches = library.suggest('sort the lines in the input file');
    assert.ok(matches.length >= 1, 'A paraphrased goal should still match on shared words.');
    assert.equal(matches[0].recipeKey, 'sort-lines:1');
    // The result is data for a caller to inspect; there is no execution path from here.
    assert.equal(typeof matches[0].spec.recipeId, 'string');
    assert.ok(matches.every((item) => item.score > 0));

    // A goal with no overlap returns nothing rather than everything.
    assert.deepEqual([...library.suggest('photograph a volcano')], []);
    // An empty goal is not a query.
    assert.deepEqual([...library.suggest('   ')], []);
  });
});

test('a stored specification still builds into a working recipe on reuse', async (t) => {
  await withLibrary(t, async ({ library }) => {
    library.record(spec(), { toolEffects });
    const stored = library.read('sorted-lines:1');
    // Rebuilding from the stored data must succeed and produce the same identity — the library stores data
    // that a caller can hand to the factory again, not a frozen object that bypasses construction.
    const rebuilt = buildRecipeFromSpec(stored.spec, { toolEffects });
    assert.equal(rebuilt.id, 'sorted-lines');
    assert.equal(rebuilt.verifier.id, 'builtin:line-set');
    // And the closed vocabulary still applies: a tampered entry cannot smuggle in a new predicate.
    assert.throws(() => buildRecipeFromSpec({ ...stored.spec, verifier: { primitive: 'invented' } },
      { toolEffects }), { code: 'invalid_recipe_spec' });
  });
});

test('the library survives a store reopen', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'recipe-library-persist-'));
  const file = join(root, 'runtime.sqlite');
  try {
    const first = new RuntimeStore(file);
    const firstLib = first.withDatabase((db) => createRecipeLibrary({ db }));
    firstLib.record(spec(), { goalPattern: 'persisted goal', toolEffects });
    firstLib.recordOutcome({ recipeKey: 'sorted-lines:1', status: 'completed', taskId: 'task-x' });
    first.close();

    // This is the point of the whole change: before it, everything the system learned about how to do a
    // kind of work died with the process.
    const second = new RuntimeStore(file);
    const secondLib = second.withDatabase((db) => createRecipeLibrary({ db }));
    const read = secondLib.read('sorted-lines:1');
    assert.equal(read.goalPattern, 'persisted goal');
    assert.equal(read.verifiedRuns, 1);
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
