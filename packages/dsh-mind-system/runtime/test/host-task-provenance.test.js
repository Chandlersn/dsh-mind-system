import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';

async function fixture(t) {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'state-'));
  writeFileSync(join(host.storage, 'input.txt'), 'input');
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir,
    workspaceRoot: host.storage, scopeRef: 'provenance-test' });
  await fiber.await();
  const agent = await host.agent('provenance-caller');
  const execute = (taskId, metadata) => host.execute('runtime_execute', { agent, arguments: {
    taskId, goal: 'Verify explicit task metadata crosses the installed host boundary.',
    inputs: { inputFile: 'input.txt', outputFile: `${taskId}.txt` },
    recipe: { recipeId: 'host-provenance', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } },
      arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'ok', createOnly: true } },
    ...metadata,
  } });
  const task = (taskId) => {
    const db = new DatabaseSync(join(stateDir, 'runtime.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT task_json FROM runs WHERE task_id = ?').get(taskId);
      return row ? JSON.parse(row.task_json) : null;
    } finally { db.close(); }
  };
  return { host, fiber, execute, task };
}

test('installed host preserves explicit origin and principle declarations in persisted tasks', async (t) => {
  const f = await fixture(t);
  try {
    const result = await f.execute('explicit', { origin: 'verification', principleRefs: ['principle:example'] });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.value.status, 'completed');
    assert.equal(f.task('explicit').origin, 'verification');
    assert.deepEqual(f.task('explicit').principleRefs, ['principle:example']);
    const empty = await f.execute('empty', { origin: 'drill', principleRefs: [] });
    assert.equal(empty.isError, false, JSON.stringify(empty.content));
    assert.deepEqual(f.task('empty').principleRefs, []);
    const legacy = await f.execute('legacy', {});
    assert.equal(legacy.isError, false, JSON.stringify(legacy.content));
    assert.equal(f.task('legacy').origin, undefined, 'An absent declaration must not become daily.');
    assert.equal(f.task('legacy').principleRefs, undefined);
  } finally { await f.fiber.dispose(); }
});

test('installed host rejects malformed metadata without creating a run or output', async (t) => {
  const f = await fixture(t);
  try {
    const inputs = [{ origin: 'production' }, { origin: null }, { principleRefs: [42] },
      { principleRefs: null }, { principleRefs: ['   '] }];
    for (const [index, metadata] of inputs.entries()) {
      const taskId = `invalid-${index}`;
      const result = await f.execute(taskId, metadata);
      assert.equal(result.isError, true, JSON.stringify(result));
      assert.equal(f.task(taskId), null);
      assert.equal(existsSync(join(f.host.storage, `${taskId}.txt`)), false);
    }
  } finally { await f.fiber.dispose(); }
});
