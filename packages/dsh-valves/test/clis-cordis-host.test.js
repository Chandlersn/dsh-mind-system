import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

function hostRoot() {
  for (const seed of [process.env.DSH_SEAM_HOST_ROOT, process.env.DSH_INSTALL_DIR, process.env.DSH_ROOT, process.argv[1], process.cwd()]) {
    if (!seed) continue;
    let dir = resolve(seed);
    for (;;) {
      if (existsSync(join(dir, 'node_modules', '@deepseek-ai', 'cordis', 'package.json')) &&
          existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js'))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
}
const root = hostRoot();
const oldInstall = process.env.DSH_INSTALL_DIR;
const oldHome = process.env.DSH_HOME;
let host, clis, valves, createClisEventReceiver, Tools, Prompt;
if (root) {
  process.env.DSH_INSTALL_DIR = root;
  const requireHost = createRequire(pathToFileURL(join(root, 'package.json')));
  host = await import(pathToFileURL(requireHost.resolve('@deepseek-ai/cordis')).href);
  const combined = new URL('../../clis/index.js', import.meta.url);
  const standalone = new URL('../../dsh-clis/index.js', import.meta.url);
  clis = await import((existsSync(combined) ? combined : standalone).href);
  valves = await import('../index.js');
  ({ createClisEventReceiver } = await import('../src/clis-event-receiver.js'));
  Tools = class extends host.Service {
    constructor(ctx) { super(ctx, 'tools'); this.items = new Map(); }
    register(tool) { this.items.set(tool.name, tool); return () => this.items.delete(tool.name); }
  };
  Prompt = class extends host.Service {
    constructor(ctx) { super(ctx, 'systemPrompt'); }
    section() { return () => {}; }
  };
}
const skip = root ? false : 'Installed host dependencies unavailable';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitUntil(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  do { if (predicate()) return; await pause(20); } while (Date.now() < deadline);
  throw new Error('Timed out waiting for event reception');
}
function restoreEnv() {
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
  if (oldInstall === undefined) delete process.env.DSH_INSTALL_DIR; else process.env.DSH_INSTALL_DIR = oldInstall;
}

test('actual Cordis fibers connect clis_run and valves with late provider and dispose', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'clis-cordis-'));
  process.env.DSH_HOME = home;
  process.env.DSH_INSTALL_DIR = root;
  const ctx = new host.Context();
  ctx.plugin(Tools);
  ctx.plugin(Prompt);
  await ctx.plugin({ name: 'clis-services-fixture', apply(c) {
    c.provide('clis.causalClassifier', { classify: async () => ({ causal_type: 'cyclic' }) });
    c.provide('clis.causalStrategy', {});
    c.provide('clis.causalOrchestrator', { run: async () => ({ classification: { causal_type: 'cyclic', judgment_basis: [], evidence: [] }, signal: { signal_type: 'effective' }, state: { traces: [] } }) });
  } });
  await ctx.plugin({ name: valves.name, inject: valves.inject, apply: c => valves.apply(c, { storageDir: join(home, 'valves'), patrol: { enabled: false } }, { clisPollMs: 20 }) });
  await ctx.plugin({ name: clis.name, inject: clis.inject, apply: clis.apply });
  try {
    const tool = ctx.tools.items.get('clis_run');
    assert.ok(tool);
    const args = { description: 'secret-marker-description', last_detail: 'secret-marker-detail', q1: 'no', q2: 'yes', q3: 'no', q4: 'no' };
    const govern = () => ctx.tools.items.get('valve_govern').execute({ principles: [{ principle_id: 'sample' }], origin: 'verification', read_clis_candidates: true }, {});
    const query = ctx.tools.items.get('clis_event_feedback');
    const lookup = ({ producerId, eventId }) => query.execute({ producerId, eventId }, {});
    const absent = await lookup({ producerId: 'ca650647-239f-40dc-8aa3-c5e432e7ee6c', eventId: 'd00a36ec-8cf8-4981-a234-905ea628d5ac' });
    assert.equal(absent.status, 'store_missing');
    assert.equal(existsSync(join(home, 'storages', 'clis-events.sqlite')), false);
    const before = await govern();
    const first = await tool.execute(args, {});
    const second = await tool.execute({ ...args, last_outcome: 'failed' }, {});
    assert.equal(first.event.status, 'persisted_pending');
    assert.equal(second.event.status, 'persisted_pending');
    const outbox = ctx.get('clisEventOutbox');
    assert.ok(outbox);
    await waitUntil(() => {
      const path = join(home, 'valves', 'clis-event-inbox.sqlite');
      if (!existsSync(path)) return false;
      const receiver = createClisEventReceiver({ filePath: path });
      try { return [first, second].every(result => receiver.get(result.event.producerId, result.event.eventId)); }
      finally { receiver.close(); }
    });
    const feedback = await lookup(second.event);
    assert.deepEqual(feedback, { status: 'recorded', schemaVersion: 1, producerId: second.event.producerId, eventId: second.event.eventId, receiptId: feedback.receiptId, classification: 'pending_failure_review', authenticated: false, humanAdoption: 'unknown', principleAttribution: 'unknown', governanceEligible: false });
    assert.equal((await lookup(first.event)).classification, 'baseline');
    const after = await govern();
    assert.deepEqual(after.clis_review.items, [{ producerId: second.event.producerId, eventId: second.event.eventId, classification: 'pending_failure_review', authenticated: false, principleAttribution: 'unknown', governanceEligible: false }]);
    for (const key of ['principle_reports', 'redefinition_proposals', 'terminated_by', 'human_gate_required']) assert.deepEqual(after[key], before[key]);
    const pending = outbox.pending({ limit: 20 });
    assert.equal(pending.length, 2);
    assert.equal(pending[0].payload.baseline, true);
    assert.equal(pending[1].payload.feedback.outcome, 'failed');
    assert.equal(JSON.stringify(pending).includes('secret-marker'), false);
    const receiver = createClisEventReceiver({ filePath: join(home, 'valves', 'clis-event-inbox.sqlite') });
    for (const event of pending) assert.equal(receiver.get(event.producerId, event.eventId)?.authenticated, false);
    receiver.close();
  } finally {
    await ctx.fiber.dispose();
    restoreEnv();
    rmSync(home, { recursive: true, force: true });
  }
});

test('metrics reading reports temporal matches without inferring visibility or trust', { skip }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'clis-metrics-reading-'));
  process.env.DSH_HOME = home;
  process.env.DSH_INSTALL_DIR = root;
  const ctx = new host.Context();
  ctx.plugin(Tools);
  ctx.plugin(Prompt);
  await ctx.plugin({ name: 'clis-metrics-services', apply(c) {
    c.provide('clis.causalClassifier', {});
    c.provide('clis.causalStrategy', {});
    c.provide('clis.causalOrchestrator', {});
  } });
  await ctx.plugin({ name: clis.name, inject: clis.inject, apply: clis.apply });
  try {
    const file = join(home, 'storages', 'clis-interventions.jsonl');
    mkdirSync(dirname(file), { recursive: true });
    const now = Date.now();
    const row = (kind, agent, delta) => ({ kind, agent, t: new Date(now + delta).toISOString() });
    const hints = Array.from({ length: 4 }, (_, i) => row('hinted', `agent-${i}`, 0));
    const read = async (events) => {
      writeFileSync(file, events.map(e => JSON.stringify(e)).join('\n') + '\n');
      return ctx.tools.items.get('clis_metrics').execute({}, {});
    };
    const low = await read([...hints, row('adopted', 'agent-0', 1000)]);
    assert.deepEqual([low.hinted, low.adopted, low.adoption_rate, low.evaluated, low.miss_rate], [4, 1, 0.25, 4, 0]);
    assert.match(low.reading, /匹配调用率 25%/);
    assert.match(low.reading, /无法证明提示被看到或信任/);
    const high = await read([...hints, row('adopted', 'agent-0', 1000), row('adopted', 'agent-1', 1000)]);
    assert.deepEqual([high.hinted, high.adopted, high.adoption_rate, high.evaluated, high.miss_rate], [4, 2, 0.5, 4, 0]);
    assert.match(high.reading, /匹配调用率 50%/);
    assert.match(high.reading, /无法证明提示被看到或信任/);
  } finally {
    await ctx.fiber.dispose();
    restoreEnv();
    rmSync(home, { recursive: true, force: true });
  }
});

test('clis_run reports unavailable durable storage', { skip }, async () => {
  const broken = mkdtempSync(join(tmpdir(), 'clis-cordis-fail-'));
  process.env.DSH_HOME = broken;
  process.env.DSH_INSTALL_DIR = root;
  writeFileSync(join(broken, 'storages'), 'not a directory');
  const ctx = new host.Context();
  ctx.plugin(Tools);
  ctx.plugin(Prompt);
  await ctx.plugin({ name: 'clis-services-fail', apply(c) {
    c.provide('clis.causalClassifier', { classify: async () => ({ causal_type: 'unknown' }) });
    c.provide('clis.causalStrategy', {});
    c.provide('clis.causalOrchestrator', { run: async () => ({ classification: { causal_type: 'unknown', judgment_basis: [], evidence: [] }, signal: {}, state: { traces: [] } }) });
  } });
  await ctx.plugin({ name: clis.name, inject: clis.inject, apply: clis.apply });
  try {
    const result = await ctx.tools.items.get('clis_run').execute({ description: 'private', q1: 'unknown', q2: 'unknown', q3: 'unknown', q4: 'unknown' }, {});
    assert.equal(result.event.status, 'persistence_failed');
    assert.equal(result.event.outbox.available, false);
    assert.ok(result.event.error);
  } finally {
    await ctx.fiber.dispose();
    restoreEnv();
    rmSync(broken, { recursive: true, force: true });
  }
});
