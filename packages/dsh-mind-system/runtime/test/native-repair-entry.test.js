import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';
import { RuntimeStore } from '../src/store.js';
import { jsonNormalizeRepairPolicy } from '../recipes/json-repair.js';

for (const scenario of ['approved', 'review', 'tool-not-granted', 'default']) {
  test(`native runtime_run handles a persisted retry: ${scenario}`, async (t) => {
    const host = await createHost(t);
    const agent = await host.agent('native-repair-caller');
    const output = join(host.storage, 'output.json');
    const source = '[{"id":"a","name":" Alpha "}]';
    writeFileSync(join(host.storage, 'source.json'), source);
    const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
    host.tools.register({ name: 'runtime_replace_json', description: 'Replace the owned fixture output.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' },
        expectedSha256: { type: 'string' } }, required: ['path', 'content', 'expectedSha256'], additionalProperties: false },
      output: { schema: {}, render: () => [] },
      execute({ path, content, expectedSha256 }, exec) {
        assert.equal(exec.agent, agent);
        assert.equal(path, output);
        assert.equal(hash(readFileSync(path)), expectedSha256);
        host.ledger('replace');
        writeFileSync(output, content);
        return { replaced: true };
      } });
    // Inject an incorrect write before the registered verifier reads the real file.
    host.ctx.on('tools/post-execute', async (exec, result, next) => {
      if (exec.name === 'runtime_write_json' && !result.isError) writeFileSync(output, '[]');
      return next();
    });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      calls++;
      assert.ok(init.signal instanceof AbortSignal);
      const { messages } = JSON.parse(init.body);
      assert.equal(messages[0].role, 'system');
      const packet = JSON.parse(messages[1].content);
      const ref = packet.verification.evidenceRefs.find((r) => r.startsWith(`file:${output}#sha256:`));
      const repair = { kind: 'retry_with', requiresHumanReview: scenario === 'review',
        diagnosis: { location: 'output', cause: 'wrong_guess', evidenceRefs: [ref] },
        candidate: { ...packet.candidate, candidateId: 'replace', toolName: 'runtime_replace_json',
          preconditionIds: jsonNormalizeRepairPolicy.requiredPreconditionIds,
          arguments: { path: output, content: packet.candidate.arguments.content, expectedSha256: ref.slice(-64) } } };
      return Response.json({ choices: [{ message: { content: JSON.stringify(repair) } }] });
    });
    const task = { taskId: 'native-task', recipeId: 'json-normalize', recipeVersion: '1', goal: 'Normalize records.',
      workspaceRoot: host.storage, scopeRef: 'native-scope', inputs: { inputFile: 'source.json', outputFile: 'output.json' },
      deadlineAt: Date.now() + 60_000, ...(scenario === 'default' ? {} : { autoRepair: true }),
      allowedTools: scenario === 'tool-not-granted' ? ['runtime_write_json'] : ['runtime_write_json', 'runtime_replace_json'] };
    const fiber = host.ctx.plugin(hostEntry.plugin, { enabled: true, tasks: [task], stateDir: host.root,
      workspaceRoot: host.storage, analysis: { endpoint: 'https://fixture.invalid/', model: 'fixture', apiKey: 'fixture' } });
    await fiber.await();
    try {
      const result = await host.execute('runtime_run', { agent, arguments: { taskRef: task.taskId } });
      assert.equal(result.isError, false, JSON.stringify(result.content));
      const receipt = result.value;
      assert.equal(calls, 1, JSON.stringify(receipt));
      assert.equal(receipt.analysis.status, 'proposed', JSON.stringify(receipt));
      assert.equal(receipt.analysis.route, 'repair_directly');
      assert.equal(receipt.status, scenario === 'approved' ? 'completed' : scenario === 'review' ? 'waiting_human' : 'waiting_analysis');
      assert.equal(host.count('replace'), scenario === 'approved' ? 1 : 0);
      assert.equal(readFileSync(join(host.storage, 'source.json'), 'utf8'), source);
      assert.deepEqual(JSON.parse(readFileSync(output)), scenario === 'approved' ? [{ id: 'a', name: 'Alpha' }] : []);
      const db = new RuntimeStore(join(host.root, 'runtime.sqlite'));
      try {
        const record = db.getAnalysis(task.taskId, receipt.analysis.analysisId);
        assert.equal(record.consumedAt !== null, scenario === 'approved');
        assert.equal(db.readRepairTrace(task.taskId).length, scenario === 'approved' ? 1 : 0);
      } finally { db.close(); }
    } finally { await fiber.dispose(); }
  });
}
