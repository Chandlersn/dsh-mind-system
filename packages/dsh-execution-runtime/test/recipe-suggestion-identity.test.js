import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRecipeLibrary } from '../src/recipe-library.js';
import { createLibraryTool } from '../src/dynamic-tools.js';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const countBasis = {
  origins: 'all_origins', historicalOriginSplit: 'unknown', success: 'selected_verifier_completion',
  failure: 'failed_or_cancelled_historical_other_statuses_possible', updateReliability: 'updates_may_be_lost_or_duplicated',
  taskUnique: false, productionEvidence: false, independentGoalProof: false,
};

test('recipe listings report identity status without granting execution', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    const library = createRecipeLibrary({ db });
    const spec = { recipeId: 'sort', tool: 'writer', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } }, arguments: {} };
    library.record(spec, { goalPattern: 'sort lines', toolEffects: { writer: 'reversible_write' } });
    library.recordOutcome({ recipeKey: 'sort:1', status: 'completed', taskId: 'one' });
    const tool = createLibraryTool({ library });
    const listing = async (args) => (await tool.execute(args)).entries[0];
    assert.equal((await listing({})).reuseStatus, 'identity_verified_requires_admission');
    assert.equal((await listing({ goal: 'sort' })).reuseStatus, 'identity_verified_requires_admission');
    assert.equal(library.read('sort:1').reuseStatus, 'identity_verified_requires_admission');
    for (const entry of [library.read('sort:1'), (await tool.execute({})).entries[0],
      (await tool.execute({ goal: 'sort' })).entries[0]]) {
      assert.deepEqual(entry.countBasis, countBasis);
      assert.equal(entry.verifiedRuns, 1);
    }
    assert.match(tool.description, /all origins.*historical origin split is unknown/i);
    assert.match(tool.description, /selected verifier.*lost or duplicated.*independently prove/i);
    const change = db.prepare('UPDATE recipe_library SET identity_json = ? WHERE recipe_key = ?');
    const identity = db.prepare('SELECT identity_json FROM recipe_library WHERE recipe_key = ?').get('sort:1').identity_json;
    for (const value of [null, '{broken', JSON.stringify({ toolEffects: { writer: 'read' } })]) {
      change.run(value, 'sort:1');
      for (const args of [{}, { goal: 'sort' }]) {
        const entry = await listing(args);
        assert.equal(entry.reuseStatus, 'identity_unverifiable');
        assert.deepEqual(entry.countBasis, countBasis);
        assert.deepEqual(entry.spec, spec);
      }
      assert.throws(() => library.assertIdentity('sort:1', identity), { code: 'recipe_identity_unverifiable' });
    }
    change.run(identity, 'sort:1');
    const setSpec = db.prepare('UPDATE recipe_library SET spec_json = ? WHERE recipe_key = ?');
    setSpec.run(JSON.stringify({ ...spec, arguments: { content: 'tampered' } }), 'sort:1');
    assert.equal((await listing({ goal: 'sort' })).reuseStatus, 'identity_unverifiable');
    assert.throws(() => library.assertIdentity('sort:1', identity), { code: 'recipe_identity_unverifiable' });
    setSpec.run('{broken', 'sort:1');
    await assert.rejects(() => tool.execute({}), { code: 'recipe_library_corrupt' });
    await assert.rejects(() => tool.execute({ goal: 'sort' }), { code: 'recipe_library_corrupt' });
  } finally { db.close(); }
});

test('host recipe tool exposes legacy identity status', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'recipe-list-'));
  const db = new DatabaseSync(join(stateDir, 'runtime.sqlite'));
  const library = createRecipeLibrary({ db });
  const spec = { recipeId: 'legacy-sort', tool: 'runtime_write_text', effect: 'reversible_write',
    verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } }, arguments: {} };
  library.record(spec, { goalPattern: 'sort lines', toolEffects: { runtime_write_text: 'reversible_write' } });
  db.prepare('UPDATE recipe_library SET identity_json = NULL, verified_runs = 7, failed_runs = 3 WHERE recipe_key = ?')
    .run('legacy-sort:1');
  const legacy = library.read('legacy-sort:1');
  assert.equal(legacy.verifiedRuns, 7);
  assert.equal(legacy.failedRuns, 3);
  assert.deepEqual(legacy.countBasis, countBasis);
  db.close();
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir,
    workspaceRoot: host.storage, scopeRef: 'recipe-list-scope' }).await();
  try {
    const agent = await host.agent('recipe-list-caller');
    for (const args of [{}, { goal: 'sort' }]) {
      const result = await host.execute('runtime_recipes', { agent, arguments: args });
      assert.equal(result.isError, false, JSON.stringify(result.content));
      assert.equal(result.value.entries[0].reuseStatus, 'identity_unverifiable');
      assert.equal(result.value.entries[0].verifiedRuns, 7);
      if (!args.goal) assert.equal(result.value.entries[0].failedRuns, 3);
      assert.deepEqual(result.value.entries[0].countBasis, countBasis);
    }
  } finally { await fiber.dispose(); }
});
