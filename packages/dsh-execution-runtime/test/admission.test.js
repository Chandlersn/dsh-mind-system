import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { admitCandidate } from '../src/admission.js';
import { createHost, installed } from './helpers/host.js';

const root = process.cwd();
const allow = async () => ({ verdict: 'allow' });
function fixture() {
  let bodies = 0;
  const tool = { name: 'fixture_write', parameters: { type: 'object', properties: {} },
    execute() { bodies++; } };
  const input = {
    task: { taskId: 'admission-task', recipeId: 'fixture', recipeVersion: '1', goal: 'Create a fixture',
      scopeRef: 'fixture-scope', workspaceRoot: root, inputs: {}, deadlineAt: Date.now() + 60_000 },
    candidate: { candidateId: 'write', toolName: tool.name, arguments: {}, progressKey: 'fixture-created',
      preconditionIds: ['target-absent'], postconditionIds: ['fixture-present'], effect: 'reversible_write',
      source: { recipeId: 'fixture', version: '1' } },
    authority: { scopeRef: 'fixture-scope', workspaceRoot: root, allowedTools: [tool.name], agent: { id: 'fixture-agent' } },
    recipe: { id: 'fixture', version: '1', allowedTools: [tool.name], toolEffects: { [tool.name]: 'reversible_write' },
      requiredPreconditionIds: ['target-absent'], preconditions: { 'target-absent': allow } },
    tools: { get(name, agent) {
      assert.equal(name, tool.name);
      assert.equal(agent, input.authority.agent);
      return tool;
    } },
    validateArguments: async ({ tool: actual, arguments: args }) => {
      assert.equal(actual, tool);
      assert.deepEqual(args, {});
      return [];
    },
  };
  return { input, tool, bodies: () => bodies };
}

async function outcome(input, verdict, reason) {
  const result = await admitCandidate(input);
  assert.equal(result.verdict, verdict, JSON.stringify(result));
  if (reason) assert.equal(result.reason, reason);
  assert.ok(result.checks.length > 0);
  if (verdict !== 'allow') assert.equal(result.checks.at(-1).result, verdict);
  return result;
}

test('explicit authority, recipe, visible tool, schema and every precondition allow without execution', async () => {
  const f = fixture();
  const calls = [];
  f.input.candidate.preconditionIds.push('scope-current');
  for (const id of f.input.candidate.preconditionIds) {
    f.input.recipe.preconditions[id] = async ({ task, candidate }) => {
      assert.equal(task.taskId, 'admission-task');
      assert.equal(candidate.source.recipeId, 'fixture');
      calls.push(id);
      return { verdict: 'allow' };
    };
  }
  const result = await outcome(f.input, 'allow', 'admitted');
  assert.deepEqual(calls, ['target-absent', 'scope-current']);
  assert.equal(result.checks.filter((check) => check.id.startsWith('precondition:')).length, 2);
  assert.equal(f.bodies(), 0);
});

test('typed lookup receives the trusted agent and resolved equivalent root is allowed', async () => {
  const { input, tool } = fixture();
  input.task.workspaceRoot = path.join(root, '..', path.basename(root));
  input.tools = async (name, agent) => {
    assert.equal(name, tool.name);
    assert.equal(agent, input.authority.agent);
    return tool;
  };
  await outcome(input, 'allow');
});

for (const [label, mutate, verdict, reason] of [
  ['malformed task', (x) => { x.task.workspaceRoot = 'relative'; }, 'deny', 'invalid_contract'],
  ['malformed candidate', (x) => { x.candidate.arguments = []; }, 'deny', 'invalid_contract'],
  ['missing trusted authority', (x) => { delete x.authority; }, 'unavailable', 'authority_missing_or_invalid'],
  ['missing authority tool list', (x) => { delete x.authority.allowedTools; }, 'unavailable', 'authority_missing_or_invalid'],
  ['model supplied authorization', (x) => { x.candidate.authority = x.authority; delete x.authority; }, 'unavailable', 'authority_missing_or_invalid'],
  ['different scope', (x) => { x.task.scopeRef = 'other-scope'; }, 'deny', 'scope_mismatch'],
  ['different real root', (x) => { x.task.workspaceRoot = path.dirname(root); }, 'deny', 'workspace_mismatch'],
  ['unresolvable root', (x) => { x.task.workspaceRoot = path.join(root, 'missing-admission-workspace'); }, 'unavailable', 'authority_unavailable'],
  ['missing recipe', (x) => { delete x.recipe; }, 'unavailable', 'recipe_missing_or_invalid'],
  ['missing required verifier declaration', (x) => { delete x.recipe.requiredPreconditionIds; }, 'unavailable', 'recipe_missing_or_invalid'],
  ['different task version', (x) => { x.task.recipeVersion = '2'; }, 'deny', 'recipe_binding_mismatch'],
  ['different source version', (x) => { x.candidate.source.version = '2'; }, 'deny', 'recipe_binding_mismatch'],
  ['different source recipe', (x) => { x.candidate.source.recipeId = 'other'; }, 'deny', 'recipe_binding_mismatch'],
  ['omitted required precondition', (x) => { x.candidate.preconditionIds = ['optional']; x.recipe.preconditions.optional = allow; }, 'deny', 'required_precondition_omitted'],
  ['unregistered required precondition', (x) => { delete x.recipe.preconditions['target-absent']; }, 'unavailable', 'required_precondition_unregistered'],
  ['unknown additional precondition', (x) => { x.candidate.preconditionIds.push('missing'); }, 'deny', 'unknown_precondition'],
  ['inherited precondition', (x) => { x.recipe.preconditions = Object.create({ 'target-absent': allow }); }, 'unavailable', 'required_precondition_unregistered'],
  ['missing trusted effect', (x) => { delete x.recipe.toolEffects; }, 'unavailable', 'effect_declaration_missing'],
  ['downgraded write effect', (x) => { x.candidate.effect = 'read'; }, 'deny', 'effect_mismatch'],
  ['unknown effect', (x) => { x.candidate.effect = 'unknown'; }, 'deny', 'effect_not_supported'],
  ['irreversible effect', (x) => { x.candidate.effect = 'irreversible'; }, 'deny', 'effect_not_supported'],
  ['tool outside authority', (x) => { x.authority.allowedTools = []; }, 'deny', 'tool_not_authorized'],
  ['tool outside recipe', (x) => { x.recipe.allowedTools = []; }, 'deny', 'tool_not_authorized'],
  ['missing lookup', (x) => { delete x.tools; }, 'unavailable', 'tool_lookup_missing'],
  ['invisible tool', (x) => { x.tools = () => undefined; }, 'deny', 'tool_not_visible'],
  ['incorrect lookup definition', (x) => { x.tools = () => ({ name: 'other' }); }, 'unavailable', 'tool_lookup_mismatch'],
  ['lookup exception', (x) => { x.tools = () => { throw new Error('lookup failed'); }; }, 'unavailable', 'tool_visibility_unavailable'],
  ['missing schema adapter', (x) => { delete x.validateArguments; }, 'unavailable', 'schema_validator_missing'],
  ['schema violations', (x) => { x.validateArguments = () => ['arguments.path: required']; }, 'deny', 'invalid_tool_arguments'],
  ['schema adapter exception', (x) => { x.validateArguments = () => { throw new Error('unsupported schema'); }; }, 'unavailable', 'arguments_unavailable'],
  ['schema adapter returns no result', (x) => { x.validateArguments = () => undefined; }, 'unavailable', 'schema_validation_invalid_result'],
  ['failing precondition', (x) => { x.recipe.preconditions['target-absent'] = async () => ({ verdict: 'deny', reason: 'target_exists' }); }, 'deny', 'target_exists'],
  ['unavailable precondition', (x) => { x.recipe.preconditions['target-absent'] = async () => ({ verdict: 'unavailable', reason: 'cannot_read_target' }); }, 'unavailable', 'cannot_read_target'],
  ['precondition exception', (x) => { x.recipe.preconditions['target-absent'] = async () => { throw new Error('read failed'); }; }, 'unavailable', 'precondition:target-absent_unavailable'],
  ['malformed precondition', (x) => { x.recipe.preconditions['target-absent'] = async () => true; }, 'unavailable', 'check_invalid_result'],
]) {
  test(`${label} cannot admit or execute a candidate`, async () => {
    const f = fixture();
    mutate(f.input);
    await outcome(f.input, verdict, reason);
    assert.equal(f.bodies(), 0);
  });
}

for (const gate of ['constraintCheck', 'negativeRuleCheck']) {
  test(`${gate} consumes explicit allow, deny and unavailable policy results`, async () => {
    for (const verdict of ['allow', 'deny', 'unavailable']) {
      const { input } = fixture();
      let called = 0;
      input[gate] = async ({ task, candidate, signal }) => {
        called++;
        assert.equal(task.scopeRef, 'fixture-scope');
        assert.equal(candidate.toolName, 'fixture_write');
        assert.equal(signal, undefined);
        return { verdict, reason: 'explicit_policy_result' };
      };
      await outcome(input, verdict, verdict === 'allow' ? 'admitted' : 'explicit_policy_result');
      assert.equal(called, 1);
    }
  });
  test(`${gate} exception or malformed callback never silently allows`, async () => {
    for (const callback of [null, async () => { throw new Error('policy offline'); }, async () => ({})]) {
      const { input } = fixture();
      input[gate] = callback;
      await outcome(input, 'unavailable');
    }
  });
}

test('aborted before admission and cancellation during every async gate stop admission', async () => {
  for (const stage of ['before', 'lookup', 'schema', 'precondition', 'policy']) {
    const { input, tool } = fixture();
    const controller = new AbortController();
    input.signal = controller.signal;
    const abort = () => controller.abort('cancel fixture');
    if (stage === 'before') abort();
    if (stage === 'lookup') input.tools = async () => { abort(); return tool; };
    if (stage === 'schema') input.validateArguments = async () => { abort(); return []; };
    if (stage === 'precondition') input.recipe.preconditions['target-absent'] = async () => { abort(); return { verdict: 'allow' }; };
    if (stage === 'policy') input.negativeRuleCheck = async () => { abort(); return { verdict: 'allow' }; };
    await outcome(input, 'unavailable', 'aborted');
  }
});

test('admission snapshots caller inputs and prevents a verifier from rewriting candidate arguments', async () => {
  const { input } = fixture();
  const original = structuredClone(input.candidate);
  input.recipe.preconditions['target-absent'] = async ({ candidate }) => {
    candidate.arguments.unchecked = true;
    return { verdict: 'allow' };
  };
  await outcome(input, 'unavailable', 'precondition:target-absent_unavailable');
  assert.deepEqual(input.candidate, original);
});

test('installed host schema validates real visible tool arguments without invoking its body', async (t) => {
  const host = await createHost(t);
  const agent = await host.agent('admission-agent');
  const { assertObjectJsonSchema, validateJsonSchemaValue } = await import(pathToFileURL(installed['dsh-tools'].entry).href);
  host.tools.register({
    name: 'fixture_write', description: 'Validate admission without execution.',
    parameters: { type: 'object', properties: { count: { type: 'integer', enum: [1, 2] } },
      required: ['count'], additionalProperties: false },
    output: { schema: {}, render: () => [] },
    async execute() { host.ledger('unexpected-body'); return {}; },
  });
  const { input } = fixture();
  input.task.workspaceRoot = host.root;
  input.authority.workspaceRoot = host.root;
  input.authority.agent = agent;
  input.tools = host.tools;
  input.validateArguments = ({ tool, arguments: args }) => {
    assertObjectJsonSchema(tool.parameters);
    return validateJsonSchemaValue(tool.parameters, args, 'arguments');
  };
  input.candidate.arguments = { count: 2 };
  await outcome(input, 'allow');
  for (const args of [{ count: '2' }, { count: 0 }, {}, { count: 2, extra: true }]) {
    input.candidate.arguments = args;
    await outcome(input, 'deny', 'invalid_tool_arguments');
  }
  const visible = host.tools.get('fixture_write', agent);
  visible.parameters = { type: 'object', properties: { count: { type: 'integer', minimum: 1 } } };
  input.candidate.arguments = { count: 2 };
  await outcome(input, 'unavailable', 'arguments_unavailable');
  agent.ctx.get('tools').restrict({ deny: ['fixture_write'] });
  await outcome(input, 'deny', 'tool_not_visible');
  assert.equal(host.count('unexpected-body'), 0);
});
