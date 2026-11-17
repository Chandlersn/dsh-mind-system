import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';

/**
 * The host entry must survive a real Cordis mount, because that is where the traps live: a swallowed
 * `inject`, an optional service read as a property, an `apply` that throws and disappears.
 *
 * These tests load through `ctx.plugin(...)` rather than calling `apply` by hand — calling apply directly
 * would prove nothing about activation.
 */

/**
 * Mount, run the body, then dispose the fiber inside the test itself.
 *
 * The host fixture removes its temp root in its own teardown; on Windows a SQLite handle still open at
 * that moment makes the removal fail with EBUSY. Disposing here keeps that lifetime explicit.
 */
async function withMount(t, makeConfig, body) {
  const host = await createHost(t);
  const config = await makeConfig(host);
  const fiber = await host.ctx.plugin(hostEntry.plugin, config);
  await fiber.await();
  try { await body(host); } finally { await fiber.dispose(); }
}

test('a disabled mount activates but exposes no runtime tool', async (t) => {
  await withMount(t, () => ({ enabled: false }), async (host) => {
    const probe = hostEntry.healthProbe.probe();
    assert.equal(probe.status, 'ok');
    assert.equal(probe.facts.state, 'disabled');
    assert.ok(probe.findings.some((item) => item.code === 'execution-runtime.disabled'));
    // Proving absence from the host side: an unregistered tool must be reported as unknown.
    const attempt = await host.execute('runtime_status', { arguments: {} });
    assert.equal(attempt.isError, true, 'A disabled runtime must not expose runtime_status.');
  });
});

test('an enabled mount registers both runtime tools in the host registry', async (t) => {
  await withMount(t, async (host) => ({ enabled: true, stateDir: mkdtempSync(join(host.root, 'state-')),
    agent: await host.agent('host-caller') }), async (host) => {
    const probe = hostEntry.healthProbe.probe();
    assert.equal(probe.status, 'ok', JSON.stringify(probe.findings));
    assert.equal(probe.facts.state, 'ready');
    assert.deepEqual(probe.facts.recipes, ['json-normalize@1', 'csv-normalize@1']);
    // The tool must be reachable through the host, not merely described by the probe.
    const status = await host.execute('runtime_status', { arguments: {} });
    assert.equal(status.isError, false, JSON.stringify(status.content));
    // The tool reports templates as objects (recipeId/version/allowedTools), not as bare strings.
    assert.deepEqual(status.value.templates.map((item) => item.recipeId),
      ['json-normalize', 'csv-normalize']);
    assert.deepEqual(status.value.tasks, []);
  });
});

test('an enabled mount with no declared task still activates and says so', async (t) => {
  await withMount(t, async (host) => ({ enabled: true, stateDir: mkdtempSync(join(host.root, 'state-')),
    agent: await host.agent('host-caller') }), async () => {
    const probe = hostEntry.healthProbe.probe();
    assert.equal(probe.facts.tasks, 0);
    assert.ok(probe.findings.some((item) => item.code === 'execution-runtime.no-tasks'),
      'A ready runtime with nothing to run must report that instead of implying it can work.');
  });
});

test('filtering every recipe still activates instead of vanishing', async (t) => {
  await withMount(t, async (host) => ({ enabled: true, stateDir: mkdtempSync(join(host.root, 'state-')),
    agent: await host.agent('host-caller'),
    recipes: { 'json-normalize': false, 'csv-normalize': false } }), async () => {
    const probe = hostEntry.healthProbe.probe();
    assert.equal(probe.facts.state, 'ready');
    assert.deepEqual(probe.facts.recipes, [], 'Both recipes were filtered out, so none may be advertised.');
  });
});

test('unloading stops the runtime instead of leaving it in flight', async (t) => {
  const host = await createHost(t);
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true,
    stateDir: mkdtempSync(join(host.root, 'state-')), agent: await host.agent('host-caller') });
  await fiber.await();
  assert.equal(hostEntry.healthProbe.probe().facts.state, 'ready');
  await fiber.dispose();
  assert.equal(hostEntry.healthProbe.probe().facts.state, 'unloaded');
});

test('a task declared to the host reaches the runtime through the tool', async (t) => {
  const taskId = randomUUID();
  await withMount(t, async (host) => {
    writeFileSync(join(host.storage, 'source.csv'), 'id,name\nb, Beta \na, Alpha \n');
    host.tools.register({ name: 'runtime.write_text', description: 'Create the owned text artifact.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' },
        createOnly: { type: 'boolean', enum: [true] } },
        required: ['path', 'content', 'createOnly'], additionalProperties: false },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: '{"created":true}' }] },
      async execute({ path, content }) { writeFileSync(path, content, { flag: 'wx' }); return { created: true }; } });
    return { enabled: true, stateDir: mkdtempSync(join(host.root, 'state-')),
      agent: await host.agent('host-caller'),
      tasks: [{ taskId, recipeId: 'csv-normalize', recipeVersion: '1', goal: 'Normalize the CSV.',
        scopeRef: 'host-scope', workspaceRoot: host.storage,
        inputs: { inputFile: 'source.csv', outputFile: 'output.csv' }, deadlineAt: Date.now() + 60_000 }] };
  }, async (host) => {
    const probe = hostEntry.healthProbe.probe();
    assert.equal(probe.facts.tasks, 1);
    // A declared task is reported by id; it has no run yet, because status never starts work.
    const status = await host.execute('runtime_status', { arguments: {} });
    assert.equal(status.isError, false, JSON.stringify(status.content));
    assert.deepEqual(status.value.tasks, [taskId]);
    // Asking for that id must report "no run" rather than invent one.
    const missing = await host.execute('runtime_status', { arguments: { taskId } });
    assert.equal(missing.isError, true, 'An undeclared run must not be reported as existing.');
  });
});
