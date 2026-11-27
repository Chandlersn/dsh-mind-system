import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';

test('real host exposes current bound outcome and refuses task replay', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'outcome-'));
  writeFileSync(join(host.storage, 'input.txt'), 'input');
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir, workspaceRoot: host.storage, scopeRef: 'outcome-scope' }).await();
  try {
    const agent = await host.agent('outcome-caller');
    const args = { taskId: 'outcome-task', origin: 'verification', goal: 'Write output', inputs: { inputFile: 'input.txt', outputFile: 'output.txt' },
      recipe: { recipeId: 'outcome', tool: 'runtime_write_text', effect: 'reversible_write',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } },
        arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'ok\n', createOnly: true } } };
    const first = await host.execute('runtime_execute', { agent, arguments: args });
    assert.equal(first.value.status, 'completed');
    assert.equal(first.value.library.succeeded, true);
    const status = await host.execute('runtime_status', { agent, arguments: { taskId: args.taskId } });
    assert.equal(status.value.run.recipeOutcome.coverage, 'bound');
    assert.equal(status.value.run.recipeOutcome.status, 'completed');
    assert.deepEqual(status.value.run.recipeOutcome.origin, { kind: 'declared', value: 'verification' });
    assert.equal((await host.execute('runtime_execute', { agent, arguments: args })).isError, true);
    const unresolved = await host.execute('runtime_execute', { agent, arguments: {
      ...args, taskId: 'outcome-unresolved', inputs: { inputFile: 'input.txt', outputFile: 'bad.txt' },
      recipe: { ...args.recipe, recipeId: 'outcome-unresolved',
        verifier: { primitive: 'line_set', parameters: { expectedLines: ['different'] } } },
    } });
    assert.equal(unresolved.value.status, 'waiting_analysis');
    assert.equal(unresolved.value.library.succeeded, null);
    const listed = await host.execute('runtime_recipes', { agent, arguments: { minVerifiedRuns: 0 } });
    const entry = listed.value.entries.find((item) => item.spec.recipeId === 'outcome-unresolved');
    assert.equal(entry.verifiedRuns, 0);
    assert.equal(entry.failedRuns, 0);
  } finally { await fiber.dispose(); }
});
