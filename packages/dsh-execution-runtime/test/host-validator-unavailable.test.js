import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHost } from './helpers/host.js';
import * as hostEntry from '../src/host-plugin.js';

function recipeArguments(outputFile) {
  return {
    taskId: randomUUID(), goal: 'Write a verified line.',
    recipe: { recipeId: 'validator-check', tool: 'runtime_write_text', effect: 'reversible_write',
      verifier: { primitive: 'line_set', parameters: { expectedLines: ['ok'] } },
      arguments: { path: '{{workspaceRoot}}/{{outputFile}}', content: 'ok\n', createOnly: true } },
    inputs: { inputFile: 'input.txt', outputFile },
  };
}

async function mount(host) {
  const fiber = await host.ctx.plugin(hostEntry.plugin, { enabled: true,
    stateDir: mkdtempSync(join(host.root, 'state-')), workspaceRoot: host.storage });
  await fiber.await();
  return fiber;
}

test('a missing host validator fails assembly and leaves no execution tools', async (t) => {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'input.txt'), 'input\n');
  const originalResolve = Module._resolveFilename;
  let fiber;
  try {
    Module._resolveFilename = function (request, ...args) {
      if (request === '@deepseek-ai/dsh-tools') {
        const error = new Error('Simulated missing host validator');
        error.code = 'MODULE_NOT_FOUND';
        throw error;
      }
      return originalResolve.call(this, request, ...args);
    };
    fiber = await mount(host);
  } finally {
    Module._resolveFilename = originalResolve;
  }
  try {
    const probe = hostEntry.healthProbe.probe();
    const agent = await host.agent('missing-validator');
    const result = await host.execute('runtime_execute', {
      agent, arguments: recipeArguments('missing.txt'),
    });
    assert.equal(existsSync(join(host.storage, 'missing.txt')), false);
    assert.equal(probe.facts.state, 'failed',
      `Missing validator must fail assembly; probe=${JSON.stringify(probe)}; run=${JSON.stringify(result.value)}`);
    assert.equal(probe.status, 'error');
    assert.equal(probe.facts.loadError, 'schema_validator_unavailable');
    assert.equal(result.isError, true, 'Assembly failure must leave runtime_execute unregistered.');
    assert.match(JSON.stringify(result.content), /unknown tool/);
  } finally {
    await fiber.dispose();
  }
});

test('the available host validator admits and completes a valid task', async (t) => {
  const host = await createHost(t);
  writeFileSync(join(host.storage, 'input.txt'), 'input\n');
  const fiber = await mount(host);
  try {
    const probe = hostEntry.healthProbe.probe();
    assert.equal(probe.facts.validator, 'host');
    assert.equal(probe.facts.state, 'ready');
    const agent = await host.agent('working-validator');
    const result = await host.execute('runtime_execute', {
      agent, arguments: recipeArguments('valid.txt'),
    });
    assert.equal(result.isError, false, JSON.stringify(result.content));
    assert.equal(result.value.status, 'completed', JSON.stringify(result.value));
    assert.equal(readFileSync(join(host.storage, 'valid.txt'), 'utf8'), 'ok\n');
  } finally {
    await fiber.dispose();
  }
});
