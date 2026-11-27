import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createRecipeLibrary } from '../src/recipe-library.js';
import { buildRecipeFromSpec, recipeIdentity } from '../src/recipe-factory.js';

const effects = { writer: 'reversible_write' };
const spec = (recipeId = 'alpha') => ({ recipeId, tool: 'writer', effect: 'reversible_write',
  verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } }, arguments: {} });
const identity = (value) => recipeIdentity(buildRecipeFromSpec(value, { toolEffects: effects }));

for (const column of ['identity_json', 'spec_json']) {
  for (const suffix of ['nul', 'utf8']) {
    test(`${column} rejects ${suffix} corruption without a write`, () => {
      const db = new DatabaseSync(':memory:');
      try {
        const lib = createRecipeLibrary({ db });
        lib.record(spec(), { goalPattern: 'alpha target', toolEffects: effects });
        lib.recordOutcome({ recipeKey: 'alpha:1', status: 'completed', taskId: 'ok' });
        lib.record(spec('good'), { goalPattern: 'good target', toolEffects: effects });
        lib.recordOutcome({ recipeKey: 'good:1', status: 'completed', taskId: 'ok' });
        const original = db.prepare(`SELECT CAST(${column} AS BLOB) AS value FROM recipe_library WHERE recipe_key = ?`).get('alpha:1').value;
        const bytes = Buffer.concat([original, suffix === 'nul' ? Buffer.from([0, 120]) : Buffer.from([0xff])]);
        db.prepare(`UPDATE recipe_library SET ${column} = CAST(? AS TEXT) WHERE recipe_key = ?`).run(bytes, 'alpha:1');
        const before = db.prepare('SELECT hex(CAST(spec_json AS BLOB)) AS spec, hex(CAST(identity_json AS BLOB)) AS identity, verified_runs, updated_at FROM recipe_library WHERE recipe_key = ?').get('alpha:1');
        assert.throws(() => lib.assertIdentity('alpha:1', identity(spec())), { code: 'recipe_identity_unverifiable' });
        assert.throws(() => lib.record(spec(), { goalPattern: 'changed', toolEffects: effects }), { code: 'recipe_identity_unverifiable' });
        assert.deepEqual(db.prepare('SELECT hex(CAST(spec_json AS BLOB)) AS spec, hex(CAST(identity_json AS BLOB)) AS identity, verified_runs, updated_at FROM recipe_library WHERE recipe_key = ?').get('alpha:1'), before);
        if (column === 'spec_json') {
          for (const action of [() => lib.read('alpha:1'), () => lib.list(), () => lib.suggest('alpha target')]) {
            assert.throws(action, { code: 'recipe_library_corrupt' });
          }
        } else {
          assert.equal(lib.read('alpha:1').reuseStatus, 'identity_unverifiable');
          assert.equal(lib.list().find((item) => item.recipeKey === 'alpha:1').reuseStatus, 'identity_unverifiable');
          assert.equal(lib.suggest('alpha target')[0].reuseStatus, 'identity_unverifiable');
        }
        assert.equal(lib.read('good:1').reuseStatus, 'identity_verified_requires_admission');
        assert.equal(lib.suggest('good')[0].recipeKey, 'good:1');
      } finally { db.close(); }
    });
  }
}

test('NUL keys cannot alias a real row or update its counters', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const lib = createRecipeLibrary({ db });
    lib.record(spec(), { toolEffects: effects });
    assert.throws(() => lib.record(spec('alpha\0tail'), { toolEffects: effects }), { code: 'recipe_identity_unverifiable' });
    assert.throws(() => lib.recordOutcome({ recipeKey: 'alpha:1\0tail', status: 'completed', taskId: 'x' }), { code: 'recipe_identity_unverifiable' });
    assert.equal(lib.read('alpha:1').verifiedRuns, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM recipe_library').get().n, 1);
  } finally { db.close(); }
});

test('corrupt ranking text and oversized text are not silently truncated', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const lib = createRecipeLibrary({ db });
    lib.record(spec(), { goalPattern: 'alpha', toolEffects: effects });
    lib.recordOutcome({ recipeKey: 'alpha:1', status: 'completed', taskId: 'ok' });
    db.prepare('UPDATE recipe_library SET goal_pattern = CAST(? AS TEXT)').run(Buffer.from([97, 0, 98]));
    assert.throws(() => lib.suggest('alpha'), { code: 'recipe_library_corrupt' });
    db.prepare('UPDATE recipe_library SET goal_pattern = ?').run('x'.repeat(1024 * 1024 + 1));
    assert.throws(() => lib.read('alpha:1'), { code: 'recipe_library_corrupt' });
  } finally { db.close(); }
});
