/**
 * Enablement check: the shipped patch must actually turn the runtime on.
 *
 * The point is not to re-test the plugin (host-plugin.test.js does that) but to prove the *declared
 * configuration* is live: read the real patch entry, assemble the plugin with it, and run one task through
 * the host. A configuration that is never exercised is indistinguishable from one that is disabled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';

const patchPath = [
  join(import.meta.dirname, '..', '..', 'cordis.patch.yml'),
  join(import.meta.dirname, '..', '..', 'dsh-mind-system', 'cordis.patch.yml'),
].find(existsSync);

/** Read the runtime entry out of the shipped patch without a YAML dependency. */
function runtimeEntryFromPatch() {
  const text = readFileSync(patchPath, 'utf8');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes('id: execution-runtime'));
  assert.ok(start >= 0, 'The shipped patch must declare an execution-runtime entry.');
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > start && /^\s{4}- id: /.test(line)) break;
    block.push(line);
  }
  const body = block.join('\n');
  return {
    name: (body.match(/name:\s*'([^']+)'/) ?? [])[1] ?? null,
    enabled: /enabled:\s*true/.test(body),
  };
}

test('the shipped patch declares the runtime enabled and points at a real export', () => {
  const entry = runtimeEntryFromPatch();
  assert.equal(entry.name, 'dsh-mind-system/runtime');
  assert.equal(entry.enabled, true, 'The shipped configuration must actually enable the runtime.');
});

test('the enabled configuration runs a task end to end in a real host', async (t) => {
  const host = await createHost(t);
  const stateDir = mkdtempSync(join(host.root, 'state-'));
  writeFileSync(join(host.storage, 'source.csv'), 'id,name\nb, Beta \na, Alpha \n');
  const taskId = randomUUID();
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true, stateDir, workspaceRoot: host.storage,
    tasks: [{ taskId, recipeId: 'csv-normalize', recipeVersion: '1', goal: 'Normalize the CSV.',
      scopeRef: 'host-scope', workspaceRoot: host.storage,
      inputs: { inputFile: 'source.csv', outputFile: 'output.csv' }, deadlineAt: Date.now() + 60_000,
      allowedTools: ['runtime_write_text'] }] });
  await fiber.await();
  try {
    const agent = await host.agent('enablement-caller');
    const run = await host.execute('runtime_run', { arguments: { taskRef: taskId }, agent });
    assert.equal(run.isError, false, JSON.stringify(run.content));
    assert.equal(run.value.status, 'completed', JSON.stringify(run.value));
    assert.equal(readFileSync(join(host.storage, 'output.csv'), 'utf8'), 'id,name\na,Alpha\nb,Beta\n');
    // The run is persisted, so the probe and status tool agree with what actually happened.
    const status = await host.execute('runtime_status', { arguments: { taskId } });
    assert.equal(status.isError, false, JSON.stringify(status.content));
    assert.equal(status.value.run.status, 'completed');
  } finally { await fiber.dispose(); }
});
