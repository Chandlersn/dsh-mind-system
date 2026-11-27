import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';
import { buildRecipeFromSpec, recipeIdentity } from '../src/recipe-factory.js';

test('host refuses identity collisions before runs, including after reload', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'identity-'));
  writeFileSync(join(host.storage, 'input.txt'), 'input');
  const config = { enabled: true, stateDir, workspaceRoot: host.storage, scopeRef: 'identity-scope' };
  let fiber = await host.ctx.plugin(hostEntry.plugin, config).await();
  const agent = await host.agent('identity-caller');
  const spec = { recipeId: 'identity-test', tool: 'runtime_write_text', effect: 'reversible_write',
    verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } },
    arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'ok\n', createOnly: true } };
  const call = (recipe, outputFile) => host.execute('runtime_execute', { agent, arguments: {
    taskId: randomUUID(), goal: 'Write output.', recipe, inputs: { inputFile: 'input.txt', outputFile } } });
  const snapshot = () => {
    const db = new DatabaseSync(join(stateDir, 'runtime.sqlite'));
    try { return { runs: db.prepare('SELECT count(*) AS n FROM runs').get().n,
      attempts: db.prepare('SELECT count(*) AS n FROM attempts').get().n,
      library: db.prepare('SELECT * FROM recipe_library ORDER BY recipe_key').all() }; }
    finally { db.close(); }
  };
  const refuse = async (recipe, output) => {
    const before = snapshot();
    const result = await call(recipe, output);
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /identity/i);
    assert.equal(existsSync(join(host.storage, output)), false);
    assert.deepEqual(snapshot(), before);
  };
  try {
    assert.equal((await call(spec, 'first.txt')).value.status, 'completed');
    await refuse({ ...spec, verifier: { primitive: 'line_set', parameters: { expectedLines: ['changed'] } } }, 'verifier.txt');
    await refuse({ ...spec, arguments: { ...spec.arguments, content: 'changed' } }, 'args.txt');
    await refuse({ ...spec, recipeId: 'json-normalize' }, 'native.txt');
    await fiber.dispose();
    fiber = await host.ctx.plugin(hostEntry.plugin, config).await();
    await refuse({ ...spec, arguments: { ...spec.arguments, content: 'changed' } }, 'restart.txt');
    const reordered = { arguments: { createOnly: true, content: 'ok\n', path: '{{workspaceRoot}}/{{outputFile}}' },
      verifier: { parameters: { expectedLines: ['ok'] }, primitive: 'line_set' }, effect: 'reversible_write',
      tool: 'runtime_write_text', version: '1', recipeId: 'identity-test' };
    assert.equal((await call(reordered, 'same.txt')).value.status, 'completed');
    const db = new DatabaseSync(join(stateDir, 'runtime.sqlite'));
    db.prepare('UPDATE recipe_library SET identity_json = NULL WHERE recipe_key = ?').run('identity-test:1');
    db.close();
    await refuse(spec, 'legacy.txt');
    const corruptDb = new DatabaseSync(join(stateDir, 'runtime.sqlite'));
    corruptDb.prepare('UPDATE recipe_library SET identity_json = ? WHERE recipe_key = ?').run('{broken', 'identity-test:1');
    corruptDb.close();
    await refuse(spec, 'corrupt.txt');
    await fiber.dispose();
    const legacyDb = new DatabaseSync(join(stateDir, 'runtime.sqlite'));
    legacyDb.exec('ALTER TABLE recipe_library DROP COLUMN identity_json');
    legacyDb.close();
    fiber = await host.ctx.plugin(hostEntry.plugin, config).await();
    await refuse(spec, 'migrated.txt');
  } finally { await fiber.dispose(); }
});

test('identity includes ordered steps, branches, arguments, verifiers and trusted effects', () => {
  const step = (id) => ({ id, tool: 'writer', effect: 'reversible_write', arguments: { value: id },
    verifier: { primitive: 'line_set', parameters: { expectedLines: [id] } } });
  const spec = { recipeId: 'multi', tool: 'writer', effect: 'reversible_write',
    verifier: { primitive: 'line_set', parameters: { expectedLines: ['end'] } },
    steps: [{ ...step('first'), next: [{ when: { kind: 'always', parameters: { value: true } }, goto: 'last' }] }, step('last')] };
  const identity = (value, effect = 'reversible_write') => recipeIdentity(buildRecipeFromSpec(value,
    { toolEffects: { writer: effect } }));
  const initial = identity(spec);
  assert.notEqual(identity({ ...spec, steps: [...spec.steps].reverse() }), initial);
  assert.notEqual(identity({ ...spec, steps: [{ ...spec.steps[0], next: [{ goto: 'last' }] }, spec.steps[1]] }), initial);
  assert.notEqual(identity({ ...spec, steps: [{ ...spec.steps[0], arguments: { value: 'changed' } }, spec.steps[1]] }), initial);
  assert.notEqual(identity({ ...spec, steps: [{ ...spec.steps[0], verifier: spec.verifier }, spec.steps[1]] }), initial);
  assert.notEqual(identity(spec, 'read'), initial);
});

test('identity rejects non-JSON objects without invoking accessors', () => {
  const base = { recipeId: 'shape', tool: 'writer', effect: 'reversible_write',
    verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } }, arguments: {} };
  const build = (value) => buildRecipeFromSpec(value, { toolEffects: { writer: 'reversible_write' } });
  let accessed = false;
  const getter = { ...base, arguments: {} };
  Object.defineProperty(getter.arguments, 'value', { enumerable: true, get() { accessed = true; return 'x'; } });
  const cycle = { ...base, arguments: {} };
  cycle.arguments.self = cycle;
  const sparse = { ...base, arguments: { values: Array(2) } };
  for (const value of [getter, cycle, sparse]) assert.throws(() => build(value), { code: 'invalid_recipe_spec' });
  assert.equal(accessed, false);
  const original = structuredClone(base);
  const built = build(original);
  const before = recipeIdentity(built);
  original.arguments.value = 'later';
  assert.equal(recipeIdentity(built), before);
});
