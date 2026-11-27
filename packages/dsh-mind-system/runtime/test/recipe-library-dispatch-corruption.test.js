import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRecipeLibrary } from '../src/recipe-library.js';
import { createExecuteTool } from '../src/dynamic-tools.js';

for (const column of ['identity_json', 'spec_json']) {
  test(`dispatch refuses NUL-corrupt ${column} without writes`, async () => {
    const db = new DatabaseSync(':memory:');
    try {
      const library = createRecipeLibrary({ db });
      const spec = { recipeId: 'alpha', tool: 'writer', effect: 'reversible_write',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } }, arguments: {} };
      const toolEffects = { writer: 'reversible_write' };
      library.record(spec, { toolEffects });
      db.exec(`UPDATE recipe_library SET ${column} = CAST(CAST(${column} AS BLOB) || x'0078' AS TEXT)`);
      const before = db.prepare(`SELECT hex(CAST(${column} AS BLOB)) AS bytes, verified_runs, failed_runs FROM recipe_library`).get();
      let dispatched = 0;
      const tool = createExecuteTool({ library, toolEffects, store: {},
        mount: { scopeRef: 'scope', workspaceRoot: 'C:\\workspace', allowedTools: ['writer'] },
        schedulerFor: () => { dispatched += 1; return {}; } });
      await assert.rejects(tool.execute({ taskId: 'test', goal: 'write', recipe: spec, inputs: {} },
        { agent: {} }), { code: 'recipe_identity_unverifiable' });
      assert.equal(dispatched, 0);
      assert.deepEqual(db.prepare(`SELECT hex(CAST(${column} AS BLOB)) AS bytes, verified_runs, failed_runs FROM recipe_library`).get(), before);
    } finally { db.close(); }
  });
}
