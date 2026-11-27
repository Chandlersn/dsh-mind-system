import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { apply } from '../server.js';
import { collectFacts, classifyEdges } from '../src/graph-runtime.js';
import { resolveDshRoot } from '../src/host.js';

const hostEntry = path.join(resolveDshRoot(process.env.DSH_INSTALL_DIR), 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js');
const { validateJsonSchemaValue } = createRequire(hostEntry)(hostEntry);

test('graph evidence tool exposes bounded historical classifier results without private inputs', async t => {
  const home = mkdtempSync(path.join(tmpdir(), 'graph-evidence-'));
  const memory = path.join(home, 'memory'), stores = path.join(home, 'storages');
  mkdirSync(memory); mkdirSync(stores);
  const oldHome = process.env.DSH_HOME, oldSag = process.env.SAG_BIN;
  process.env.DSH_HOME = home; process.env.SAG_BIN = path.join(home, 'missing-sag');
  const tools = new Map(), noop = () => {};
  const ctx = { tools: { register(tool) { tools.set(tool.name, tool); return noop; } }, get() {}, on() { return noop; },
    systemPrompt: { getSectionOrder: () => 2900, section: () => noop },
    inject(_names, fn) { fn({ webServer: undefined, workspaceRegistry: undefined }); } };
  const dispose = apply(ctx, { memoryRoot: memory, skillRoot: path.join(home, 'skills'), dshRoot: process.env.DSH_INSTALL_DIR, dailyArchiveFirstDelayMs: 0, dailyArchiveIntervalMs: 0 });
  t.after(() => { dispose(); if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome; if (oldSag === undefined) delete process.env.SAG_BIN; else process.env.SAG_BIN = oldSag; rmSync(home, { recursive: true, force: true }); });
  const tool = tools.get('memory_read');
  async function read() {
    const args = { kind: 'graph_evidence' }, result = await tool.execute(args);
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, result, 'value'), []);
    assert.equal(tool.output.render(args, result)[0].text, result.content);
    return JSON.parse(result.content);
  }
  const before = readdirSync(memory);
  let data = await read();
  assert.equal(data.currentActivity, 'unknown');
  assert.ok(data.edges.every(edge => edge.status === 'unknown'));
  assert.equal(data.checks.unknown, data.checks.total);
  for (const extra of [{ name: 'secret' }, { date: 'x' }, { path: 'x' }, { limit: 1 }, { [Symbol('hidden')]: 1 }]) await assert.rejects(tool.execute({ kind: 'graph_evidence', ...extra }), /only kind|lossless JSON object/);
  const producer = new DatabaseSync(path.join(stores, 'clis-events.sqlite'));
  const consumer = new DatabaseSync(path.join(stores, 'clis-event-inbox.sqlite'));
  producer.exec("CREATE TABLE clis_meta(key TEXT,value TEXT); INSERT INTO clis_meta VALUES('producer_id','secret-producer'); CREATE TABLE clis_events(event_id TEXT); CREATE TABLE clis_receipts(receipt_id TEXT,event_id TEXT,evidence TEXT,evidence_hash TEXT)");
  consumer.exec('CREATE TABLE clis_event_inbox(producer_id TEXT,event_id TEXT); CREATE TABLE clis_event_results(producer_id TEXT,event_id TEXT,receipt_id TEXT,status TEXT)');
  const evidence = JSON.stringify({ producerId: 'secret-producer', eventId: 'secret-event', receiptId: 'secret-receipt', status: 'received', receivedAt: '2026-11-26T00:00:00Z', payload: 'secret-payload' });
  producer.prepare('INSERT INTO clis_events VALUES (?)').run('secret-event');
  producer.prepare('INSERT INTO clis_receipts VALUES (?,?,?,?)').run('secret-receipt', 'secret-event', evidence, createHash('sha256').update(evidence).digest('hex'));
  consumer.prepare('INSERT INTO clis_event_inbox VALUES (?,?)').run('secret-producer', 'secret-event');
  consumer.prepare('INSERT INTO clis_event_results VALUES (?,?,?,?)').run('secret-producer', 'secret-event', 'secret-receipt', 'received');
  data = await read();
  const expected = classifyEdges(collectFacts({ dshHome: home }));
  assert.deepEqual(data.edges.map(e => [e.id, e.graphEdge, e.status, e.detail]), expected.map(e => [e.id, e.graphEdge, e.status, e.detail]));
  const receipt = data.edges.find(e => e.id === 'outbox -> valves inbox');
  assert.equal(receipt.status, 'observed'); assert.equal(receipt.evidenceScope, 'historical');
  assert.equal(receipt.latestReceiptAt, '2026-11-26T00:00:00Z');
  assert.equal(data.checks.historicalObserved, 1);
  assert.doesNotMatch(JSON.stringify(data), /secret|payload|sqlite/);
  producer.exec("UPDATE clis_receipts SET evidence_hash='corrupt'");
  data = await read();
  assert.equal(data.edges.find(e => e.id === 'outbox -> valves inbox').status, 'unknown');
  producer.close(); consumer.close();
  writeFileSync(path.join(stores, 'clis-events.sqlite'), 'corrupt');
  data = await read();
  assert.equal(data.edges.find(e => e.id === 'outbox -> valves inbox').status, 'unknown');
  assert.deepEqual(readdirSync(memory), before);
});
