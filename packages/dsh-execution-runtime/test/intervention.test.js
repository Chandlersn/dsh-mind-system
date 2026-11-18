import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterventionPolicy, hintText } from '../src/intervention.js';

/**
 * Intervention: the runtime makes itself known when a caller is in trouble, and stays quiet otherwise.
 *
 * The risk this file guards against is a component that either never speaks (so it effectively does not
 * exist) or speaks on everything (so it is ignored, which is the same outcome). Both are checked, and the
 * counters are asserted as a pair: a hint count without a denominator cannot be read.
 */

const NOW = 1_000_000;
const clock = (start = NOW) => { let at = start; const now = () => at; now.advance = (ms) => { at += ms; }; return now; };

test('the same failure has to repeat before the runtime speaks', () => {
  const policy = createInterventionPolicy({ threshold: 2, now: () => NOW });
  const message = 'verification failed: output does not match';
  // One occurrence is not enough: a single failure is ordinary and offering help for it would be noise.
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message }).skipped, 'below_threshold');
  const second = policy.evaluate({ agentId: 'a', tool: 't', message });
  assert.ok(second.hint, JSON.stringify(second));
  // A third identical failure must not repeat the hint: one note per signature is enough.
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message }).skipped, 'already_hinted');
});

test('failures the runtime could not help with are ignored outright', () => {
  const policy = createInterventionPolicy({ threshold: 1, now: () => NOW });
  for (const message of ['syntax error near token', 'file not found', 'permission denied']) {
    const verdict = policy.evaluate({ agentId: 'a', tool: 't', message });
    assert.equal(verdict.skipped, 'not_relevant', message);
    assert.equal(verdict.hint, undefined);
  }
  // Nothing was hinted, and every evaluation was recorded — that the counters move is what proves the
  // policy was watching rather than absent.
  const metrics = policy.metrics();
  assert.equal(metrics.hinted, 0);
  assert.equal(metrics.evaluated, 3);
  assert.equal(metrics.skipped, 3);
});

test('a failure described in the caller\'s words is recognised, not just one quoting an error code', () => {
  // The vocabulary was once the runtime's own error codes only (`budget_exceeded`, `half_`,
  // `reconciling`). Measured against real failures that matched 3.0% of them and missed 11 of 12
  // cases that genuinely needed help: a caller writes what happened, not the internal code name.
  // This test pins the caller's phrasing so the list cannot quietly narrow back to self-description.
  for (const message of [
    'the produced artifact does not match what the task declared',
    'the write landed on disk but no ledger row was recorded for it',
    'the checkpoint cursor no longer matches the journal entries',
    'the process died with 3 of 7 files written',
    'the compensation step did not settle the target fact',
    'two attempts claim the same fence token',
  ]) {
    const policy = createInterventionPolicy({ threshold: 1, now: () => NOW });
    const verdict = policy.evaluate({ agentId: 'a', tool: 't', message });
    assert.notEqual(verdict.skipped, 'not_relevant', `caller-style failure not recognised: ${message}`);
    assert.ok(verdict.hint !== undefined, `should have offered help: ${message}`);
  }
});

test('widening the vocabulary did not make ordinary mistakes look actionable', () => {
  // The trade-off is real: a longer list buys recall and risks matching noise. The design
  // requirement is that a typo, a parse error or a missing argument stays invisible, so that is
  // asserted directly rather than trusted to the shape of the word list.
  for (const message of [
    'SyntaxError: Unexpected token } in the module body',
    'EACCES: permission denied writing to the profile directory',
    'invalid arguments: missing required property "file_path"',
    'old_string was not found in the target file',
    'command not found: ffprobe is not on PATH',
    'rg: no matches found for the pattern in the tree',
  ]) {
    const policy = createInterventionPolicy({ threshold: 1, now: () => NOW });
    const verdict = policy.evaluate({ agentId: 'a', tool: 't', message });
    assert.equal(verdict.skipped, 'not_relevant', `ordinary mistake became actionable: ${message}`);
  }
});

test('the cooldown is per agent and expires', () => {
  const now = clock();
  const policy = createInterventionPolicy({ threshold: 1, cooldownMs: 60_000, now });
  assert.ok(policy.evaluate({ agentId: 'a', tool: 't', message: 'timeout' }).hint);
  // A different signature from the same agent inside the cooldown is suppressed.
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message: 'deadline exceeded' }).skipped, 'cooldown');
  // Another agent is unaffected: the cooldown is a per-caller courtesy, not a global mute.
  assert.ok(policy.evaluate({ agentId: 'b', tool: 't', message: 'timeout' }).hint);
  // After the window, the first agent can be helped again.
  now.advance(61_000);
  assert.ok(policy.evaluate({ agentId: 'a', tool: 't', message: 'rollback failed' }).hint);
});

test('an old failure stops counting toward a present one', () => {
  const now = clock();
  const policy = createInterventionPolicy({ threshold: 2, cooldownMs: 60_000, now });
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message: 'timeout' }).skipped, 'below_threshold');
  // Beyond the window the earlier observation is dropped, so this remains a first occurrence.
  now.advance(120_000);
  assert.equal(policy.evaluate({ agentId: 'a', tool: 't', message: 'timeout' }).skipped, 'below_threshold');
});

test('the counters are reported with their denominator', () => {
  const policy = createInterventionPolicy({ threshold: 1, now: () => NOW });
  policy.evaluate({ agentId: 'a', tool: 't', message: 'syntax error' });
  policy.evaluate({ agentId: 'a', tool: 't', message: 'timeout' });
  const metrics = policy.metrics();
  // hinted alone would look identical to "nobody is watching"; skipped is the denominator.
  assert.equal(metrics.hinted, 1);
  assert.equal(metrics.skipped, 1);
  assert.equal(metrics.evaluated, 2);
  assert.equal(metrics.missRate, 0.5);
  assert.equal(metrics.skippedByReason.not_relevant, 1);
});

test('a hint offers help without instructing the caller', () => {
  const text = hintText();
  // It must name the capability and explicitly leave the decision open.
  assert.match(text, /runtime_execute/);
  assert.match(text, /不一定要用/);
  // It must not claim the task failed, nor order a repair: the runtime does not decide for a caller.
  // Match an imperative at the start of a clause, not the substring inside 「不一定要用」.
  assert.doesNotMatch(text, /(?:^|[；。\n])\s*(?:必须|立即|一定要|请)/u);
  assert.doesNotMatch(text, /已经失败|任务失败了/u);
});

test('one agent cannot grow the tracked set without bound', () => {
  const policy = createInterventionPolicy({ threshold: 1, maxTrackedAgents: 3, now: () => NOW });
  for (const agentId of ['a', 'b', 'c', 'd', 'e']) {
    policy.evaluate({ agentId, tool: 't', message: 'timeout' });
  }
  // The oldest agents are evicted rather than accumulated; each new evaluation still works.
  assert.equal(policy.metrics().evaluated, 5);
  assert.equal(policy.metrics().hinted, 5);
});

test('a failing shell command is a failure even when the tool itself succeeded', async (t) => {
  // This is the shape a shell tool reports: `isError: false` (the tool ran) with the command's non-zero exit
  // in `value.exitCode`. Treating only `isError` as failure made the runtime blind to every shell failure —
  // observed live as silence on the same repeated event where CLIS spoke.
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  let cordis;
  for (const root of ['D:/dsh', process.env.DSH_INSTALL_DIR].filter(Boolean)) {
    try {
      const require = createRequire(pathToFileURL(join(root, 'package.json')));
      cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
      break;
    } catch { /* try the next root */ }
  }
  if (!cordis) return t.skip('cordis unavailable');

  const app = new cordis.Context();
  const registered = new Map();
  app.provide?.('tools');
  app.set('tools', {
    register(tool) { registered.set(tool.name, tool); return () => registered.delete(tool.name); },
    get(name) { return registered.get(name) ?? null; },
    list() { return [...registered.keys()]; },
    async execute() { return { isError: false, content: [] }; },
  });

  const entry = new URL('../src/host-plugin.js', import.meta.url).href;
  const pluginModule = await import(entry);
  const plugin = pluginModule.default ?? pluginModule.plugin ?? pluginModule;
  const stateDir = mkdtempSync(join(tmpdir(), 'shell-fail-'));
  const fiber = app.plugin(plugin, { enabled: true, stateDir, workspaceRoot: stateDir, scopeRef: 's' });
  await fiber.await?.();
  try {
    const fire = () => app.waterfall('tools/post-execute',
      { name: 'pwsh', agent: { id: 'shell-agent' } },
      { isError: false, value: { exitCode: 1, stderr: { text: 'verification failed: mismatch' } },
        content: [{ type: 'text', text: 'exit code 1' }] },
      () => Promise.resolve({ additionalContexts: [] }));
    const first = await fire();
    const second = await fire();
    assert.equal((first?.additionalContexts ?? []).length, 0, 'The first failure must stay silent.');
    assert.equal((second?.additionalContexts ?? []).length, 1,
      'A repeated shell failure must produce a hint; before the fix it produced none.');
  } finally {
    await fiber?.dispose?.();
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a signalled process is not treated as a command failure', async (t) => {
  // A killed process also exits non-zero. Counting that as failure would hint on every timeout kill, which
  // is exactly the kind of noise that gets a component ignored.
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  let cordis;
  for (const root of ['D:/dsh', process.env.DSH_INSTALL_DIR].filter(Boolean)) {
    try {
      const require = createRequire(pathToFileURL(join(root, 'package.json')));
      cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
      break;
    } catch { /* try the next root */ }
  }
  if (!cordis) return t.skip('cordis unavailable');

  const app = new cordis.Context();
  app.provide?.('tools');
  app.set('tools', {
    register() { return () => {}; }, get() { return null; }, list() { return []; },
    async execute() { return { isError: false, content: [] }; },
  });
  const pluginModule = await import(new URL('../src/host-plugin.js', import.meta.url).href);
  const plugin = pluginModule.default ?? pluginModule.plugin ?? pluginModule;
  const stateDir = mkdtempSync(join(tmpdir(), 'signal-case-'));
  const fiber = app.plugin(plugin, { enabled: true, stateDir, workspaceRoot: stateDir, scopeRef: 's' });
  await fiber.await?.();
  try {
    const fire = () => app.waterfall('tools/post-execute',
      { name: 'pwsh', agent: { id: 'killed-agent' } },
      // The text must contain a relevant word, otherwise the policy stops at `not_relevant` and this test
      // never reaches the signal predicate it is meant to exercise.
      { isError: false, value: { exitCode: 143, signal: 'SIGTERM',
        stderr: { text: 'timeout: killed after the deadline' } },
        content: [{ type: 'text', text: 'exit code 143' }] },
      () => Promise.resolve({ additionalContexts: [] }));
    await fire();
    const second = await fire();
    // Even repeated, a cancelled process produces no hint.
    assert.equal((second?.additionalContexts ?? []).length, 0,
      'A signalled process is a cancellation, not a failure to comment on.');
  } finally {
    await fiber?.dispose?.();
    rmSync(stateDir, { recursive: true, force: true });
  }
});
