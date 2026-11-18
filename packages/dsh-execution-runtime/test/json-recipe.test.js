import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { buildJsonCandidate, prepareJsonTask, verifyJsonOutput } from '../recipes/json-normalize.js';

function fixture(t, source = [{ id: 'b', name: ' Beta ' }, { id: 'a', name: ' Alpha ' }]) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-recipe-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('runtime-recipe-'));
    rmSync(root, { recursive: true, force: true });
  });
  writeFileSync(join(root, 'source.json'), JSON.stringify(source));
  const options = { taskId: 'normalize-1', workspaceRoot: root, inputFile: 'source.json', outputFile: 'output.json',
    scopeRef: 'temporary-workspace', deadlineAt: Date.now() + 60_000 };
  return { root, options, task: () => prepareJsonTask(options) };
}

test('the fixture recipe creates a complete action and independently verifies exact target facts', (t) => {
  const fixtureState = fixture(t);
  const task = fixtureState.task();
  const candidate = buildJsonCandidate(task);
  assert.equal(candidate.toolName, 'runtime_write_json');
  assert.equal(candidate.arguments.createOnly, true);
  assert.equal(verifyJsonOutput(task).status, 'fail');
  writeFileSync(candidate.arguments.path, candidate.arguments.content, { flag: 'wx' });
  const result = verifyJsonOutput(task);
  assert.equal(result.status, 'pass');
  assert.equal(result.goalSatisfied, true);
  assert.equal(result.evidenceRefs.length, 2);
  assert.deepEqual(JSON.parse(readFileSync(join(fixtureState.root, 'output.json'), 'utf8')),
    [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
  assert.deepEqual(JSON.parse(readFileSync(join(fixtureState.root, 'source.json'), 'utf8')),
    [{ id: 'b', name: ' Beta ' }, { id: 'a', name: ' Alpha ' }]);
});

for (const [name, badOutput] of [
  ['wrong names', [{ id: 'a', name: 'wrong' }, { id: 'b', name: 'Beta' }]],
  ['wrong order', [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }]],
  ['duplicate ids', [{ id: 'a', name: 'Alpha' }, { id: 'a', name: 'Alpha' }]],
  ['missing records', [{ id: 'a', name: 'Alpha' }]],
  ['extra properties', [{ id: 'a', name: 'Alpha', accepted: true }, { id: 'b', name: 'Beta' }]],
  ['unstructured output', { success: true }],
]) {
  test(`a tool success claim cannot hide ${name}`, (t) => {
    const fixtureState = fixture(t);
    const task = fixtureState.task();
    writeFileSync(join(fixtureState.root, 'output.json'), JSON.stringify(badOutput));
    const result = verifyJsonOutput(task);
    assert.equal(result.status, 'fail');
    assert.equal(result.goalSatisfied, false);
    assert.equal(result.reason, 'output_mismatch');
  });
}

test('changed source and existing output prohibit blind action replay', (t) => {
  const fixtureState = fixture(t);
  const task = fixtureState.task();
  const candidate = buildJsonCandidate(task);
  writeFileSync(candidate.arguments.path, candidate.arguments.content, { flag: 'wx' });
  assert.throws(() => buildJsonCandidate(task), { code: 'output_exists' });
  assert.throws(() => fixtureState.task(), { code: 'output_exists' });
  writeFileSync(join(fixtureState.root, 'source.json'), '[]');
  assert.equal(verifyJsonOutput(task).status, 'unknown');
  assert.equal(verifyJsonOutput(task).reason, 'input_changed');
});

test('source version drift before candidate construction is rejected', (t) => {
  const fixtureState = fixture(t);
  const task = fixtureState.task();
  writeFileSync(join(fixtureState.root, 'source.json'), '[]');
  assert.throws(() => buildJsonCandidate(task), { code: 'input_changed' });
});

test('path traversal and input-output aliasing are rejected before execution', (t) => {
  const fixtureState = fixture(t);
  assert.throws(() => prepareJsonTask({ ...fixtureState.options, outputFile: '../outside.json' }), { code: 'invalid_scope' });
  assert.throws(() => prepareJsonTask({ ...fixtureState.options, outputFile: 'source.json' }), { code: 'invalid_scope' });
  assert.throws(() => prepareJsonTask({ ...fixtureState.options, inputFile: 'sub/source.json' }), { code: 'invalid_scope' });
});

test('malformed UTF-8 source bytes are rejected instead of silently repaired', (t) => {
  const fixtureState = fixture(t);
  writeFileSync(join(fixtureState.root, 'source.json'), Buffer.concat([
    Buffer.from('[{"id":"a","name":"'), Buffer.from([0xff]), Buffer.from('"}]'),
  ]));
  assert.throws(() => fixtureState.task(), { code: 'invalid_recipe_input' });
});

test('a replacement character in valid source cannot mask malformed output bytes', (t) => {
  const fixtureState = fixture(t, [{ id: 'a', name: '\uFFFD' }]);
  const task = fixtureState.task();
  writeFileSync(join(fixtureState.root, 'output.json'), Buffer.concat([
    Buffer.from('[{"id":"a","name":"'), Buffer.from([0xff]), Buffer.from('"}]'),
  ]));
  const result = verifyJsonOutput(task);
  assert.equal(result.status, 'fail');
  assert.equal(result.goalSatisfied, false);
  assert.equal(result.reason, 'output_invalid_json');
});

test('duplicate or malformed source records cannot generate a candidate', (t) => {
  const fixtureState = fixture(t, [{ id: 'a', name: 'Alpha' }, { id: 'a', name: 'Again' }]);
  assert.throws(() => fixtureState.task(), { code: 'invalid_recipe_input' });
});
