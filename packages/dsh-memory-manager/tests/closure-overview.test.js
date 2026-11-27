// Real apply + passive event observation, exclusively against a temporary DSH_HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

const mod = await import('../server.js');
const noop = () => {};

async function setup(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'closure-overview-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const root = path.join(home, 'memory');
  const skills = path.join(home, 'skills');
  await mkdir(root, { recursive: true });
  await mkdir(skills, { recursive: true });
  await writeFile(path.join(root, 'MEMORY.md'), '# isolated index\n', 'utf8');
  const oldHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
  });

  const hooks = new Map();
  const on = (name, fn) => {
    if (!hooks.has(name)) hooks.set(name, []);
    hooks.get(name).push(fn);
    return noop;
  };
  const fire = async (name, ...args) => {
    for (const fn of hooks.get(name) ?? []) await fn(...args);
  };
  let handler;
  const ctx = {
    tools: { register: () => noop },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    on,
    get() { return undefined; },
    set() {},
    emit: noop,
    inject(_names, fn) {
      fn({
        webServer: { register(route) { if (route.path === '/api/memory-org') handler = route.handler; return noop; } },
        connection: { requestRejection: () => undefined },
        effect(f) { return f(); },
      });
    },
  };
  const dispose = mod.apply(ctx, {
    memoryRoot: root,
    skillRoot: skills,
    captureUserTurns: false,
    recallTimeoutMs: 100,
    dshRoot: process.env.DSH_INSTALL_DIR,
  });
  t.after(() => { try { dispose(); } catch { /* best effort */ } });

  const overview = async () => {
    let status, body;
    await handler({ method: 'GET', url: '/api/memory-org/overview' }, {
      writeHead(code) { status = code; }, end(value) { body = value; },
    });
    assert.equal(status, 200);
    return JSON.parse(body)[0];
  };
  return { hooks, fire, overview };
}

test('overview exposes automatic closure evidence without self-asserting a loop', async (t) => {
  const { overview } = await setup(t);
  const payload = await overview();
  const ce = payload.closureEvidence;
  assert.ok(ce, 'closure evidence must be present in overview');
  assert.equal(ce.status, 'ok');
  assert.equal(ce.correlation, 'required', 'no task id supplied in overview');
  assert.equal(ce.reviewSupplied, false, 'overview supplies no human review');
  assert.equal(ce.independentReview, false);
  assert.equal(ce.chain, 'unknown');
  assert.equal(ce.closureClaim, 'not_asserted');
  assert.equal(ce.humanAdoption, 'not_evaluated');
  assert.equal(ce.governanceEligible, false);
  assert.equal(typeof ce.observation?.recall, 'boolean');
  assert.equal(typeof ce.observation?.action, 'boolean');
  assert.equal(typeof ce.observation?.result, 'boolean');
});

test('automatic observation follows passive tool events without claiming review', async (t) => {
  const { hooks, fire, overview } = await setup(t);
  assert.ok((hooks.get('tools/execute') ?? []).length > 0);
  assert.ok((hooks.get('tools/result') ?? []).length > 0);

  const exec = { name: 'memory_write', token: Symbol('closure-token'), arguments: {} };
  await fire('tools/execute', exec, async () => undefined);
  await fire('tools/result', exec, { isError: false });

  const ce = (await overview()).closureEvidence;
  assert.equal(ce.observation.result, true, 'finished tool hop observed automatically');
  assert.equal(ce.independentReview, false, 'tool events never supply human review');
  assert.equal(ce.closureClaim, 'not_asserted');
  const raw = JSON.stringify(ce);
  assert.doesNotMatch(raw, /arguments|token|private/, 'no tool payloads leak');
});
