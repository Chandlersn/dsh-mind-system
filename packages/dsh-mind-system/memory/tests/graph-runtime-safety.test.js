import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { collectFacts, classifyEdges } from '../src/graph-runtime.js';

const status = facts => classifyEdges(facts).find(e => e.id === 'outbox -> valves inbox').status;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-match-'));
  const clisDb = join(dir, 'producer.sqlite'), valveDb = join(dir, 'consumer.sqlite');
  const producer = new DatabaseSync(clisDb), consumer = new DatabaseSync(valveDb);
  producer.exec("CREATE TABLE clis_meta(key TEXT,value TEXT); INSERT INTO clis_meta VALUES('producer_id','p1'); CREATE TABLE clis_events(event_id TEXT); CREATE TABLE clis_receipts(receipt_id TEXT,event_id TEXT,evidence TEXT,evidence_hash TEXT)");
  consumer.exec('CREATE TABLE clis_event_inbox(producer_id TEXT,event_id TEXT); CREATE TABLE clis_event_results(producer_id TEXT,event_id TEXT,receipt_id TEXT,status TEXT)');
  return { dir, clisDb, valveDb, producer, consumer };
}
function addReceipt(f, i = 1, receivedAt) {
  const event = `e${i}`, receipt = `r${i}`;
  const evidence = JSON.stringify({ producerId: 'p1', eventId: event, receiptId: receipt, status: 'received', receivedAt });
  const hash = createHash('sha256').update(evidence).digest('hex');
  f.producer.prepare('INSERT INTO clis_events VALUES (?)').run(event);
  f.producer.prepare('INSERT INTO clis_receipts VALUES (?,?,?,?)').run(receipt, event, evidence, hash);
  f.consumer.prepare('INSERT INTO clis_event_inbox VALUES (?,?)').run('p1', event);
  f.consumer.prepare('INSERT INTO clis_event_results VALUES (?,?,?,?)').run('p1', event, receipt, 'received');
}
function close(f) { f.producer.close(); f.consumer.close(); rmSync(f.dir, { recursive: true, force: true }); }

test('matching producer receipt and consumer identity provide evidence for C to V', () => {
  const f = fixture();
  try {
    addReceipt(f);
    const facts = collectFacts({ clisDb: f.clisDb, valveDb: f.valveDb });
    assert.equal(facts.receiptMatch, 1);
    assert.equal(status(facts), 'observed');
    const matched = classifyEdges(facts).find(e => e.id === 'outbox -> valves inbox');
    assert.equal(matched.evidenceScope, 'historical');
    assert.equal(matched.currentActivity, 'unknown');
    assert.ok(classifyEdges(facts).filter(e => e.id !== 'outbox -> valves inbox').every(e => e.status === 'unknown'));
  } finally { close(f); }
});

test('receipt timestamps come from verified evidence and preserve legacy status', () => {
  const f = fixture();
  try {
    addReceipt(f, 1, '2026-11-26T01:00:00.000Z');
    addReceipt(f, 2, '2026-11-26T10:30:00+08:00');
    addReceipt(f, 3, 'invalid');
    const getEdge = () => classifyEdges(collectFacts({ clisDb: f.clisDb, valveDb: f.valveDb })).find(e => e.id === 'outbox -> valves inbox');
    assert.equal(getEdge().latestReceiptAt, '2026-11-26T10:30:00+08:00');
    f.producer.exec("UPDATE clis_receipts SET evidence_hash='bad' WHERE receipt_id='r1'");
    assert.equal(getEdge().status, 'unknown');
    assert.equal(getEdge().latestReceiptAt, null);
  } finally { close(f); }
  for (const value of [undefined, 'invalid', '2026-02-30T00:00:00Z', '2099-01-01T00:00:00Z']) {
    const legacy = fixture();
    try {
      addReceipt(legacy, 1, value);
      const edge = classifyEdges(collectFacts({ clisDb: legacy.clisDb, valveDb: legacy.valveDb })).find(e => e.id === 'outbox -> valves inbox');
      assert.equal(edge.status, 'observed');
      assert.equal(edge.latestReceiptAt, value === '2099-01-01T00:00:00Z' ? value : null);
      assert.equal(edge.currentActivity, 'unknown');
    } finally { close(legacy); }
  }
});

test('mismatched producer, event, receipt or corrupted evidence is unknown', () => {
  for (const change of ["UPDATE clis_event_results SET producer_id='other'", "UPDATE clis_event_results SET event_id='other'", "UPDATE clis_event_results SET receipt_id='other'"]) {
    const f = fixture();
    try {
      addReceipt(f); f.consumer.exec(change);
      assert.equal(status(collectFacts({ clisDb: f.clisDb, valveDb: f.valveDb })), 'unknown');
    } finally { close(f); }
  }
  const f = fixture();
  try {
    addReceipt(f); f.producer.exec("UPDATE clis_receipts SET evidence_hash='bad'");
    assert.equal(status(collectFacts({ clisDb: f.clisDb, valveDb: f.valveDb })), 'unknown');
  } finally { close(f); }
});

test('missing database and truncated receipt scan are unknown', () => {
  const f = fixture();
  try {
    assert.equal(status(collectFacts({ clisDb: join(f.dir, 'missing'), valveDb: f.valveDb })), 'unknown');
    f.producer.exec('BEGIN'); f.consumer.exec('BEGIN');
    for (let i = 0; i < 101; i++) addReceipt(f, i);
    f.producer.exec('COMMIT'); f.consumer.exec('COMMIT');
    assert.equal(status(collectFacts({ clisDb: f.clisDb, valveDb: f.valveDb })), 'unknown');
  } finally { close(f); }
});

function producerFixture(count = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'graph-producer-'));
  const clisDb = join(dir, 'producer.sqlite');
  const db = new DatabaseSync(clisDb);
  const producerId = randomUUID();
  db.exec('CREATE TABLE clis_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE clis_events(seq INTEGER PRIMARY KEY,event_id TEXT UNIQUE,kind TEXT,payload TEXT,payload_hash TEXT,created_at TEXT); CREATE TABLE clis_outbox(event_id TEXT PRIMARY KEY,status TEXT)');
  db.prepare('INSERT INTO clis_meta VALUES (?,?)').run('producer_id', producerId);
  for (let seq = 1; seq <= count; seq++) {
    const id = randomUUID(), kind = 'example', payload = '{}', created = '2026-11-26T00:00:00.000Z';
    const hash = createHash('sha256').update(JSON.stringify([producerId, id, kind, payload, created, seq])).digest('hex');
    db.prepare('INSERT INTO clis_events VALUES (?,?,?,?,?,?)').run(seq, id, kind, payload, hash, created);
    db.prepare('INSERT INTO clis_outbox VALUES (?,?)').run(id, 'pending');
  }
  db.close();
  return { dir, clisDb };
}
const observation = f => collectFacts({ clisDb: f.clisDb, valveDb: join(f.dir, 'missing-consumer') }).producerObservation;
function changeProducer(f, sql) { const db = new DatabaseSync(f.clisDb); try { db.exec(sql); } finally { db.close(); } }

test('producer-local observation is bounded and never makes the graph edge running', () => {
  for (const count of [0, 1, 100, 101]) {
    const f = producerFixture(count);
    try {
      const before = readFileSync(f.clisDb);
      const facts = collectFacts({ clisDb: f.clisDb, valveDb: join(f.dir, 'missing-consumer') });
      assert.deepEqual(readFileSync(f.clisDb), before);
      assert.equal(facts.producerObservation.status, count > 100 ? 'incomplete' : 'complete');
      assert.equal(facts.producerObservation.matchedEvents, count > 100 ? undefined : count);
      assert.equal(facts.producerObservation.source, 'local_producer_store');
      assert.equal(facts.producerObservation.consumption, 'unknown');
      assert.equal(facts.producerObservation.currentActivity, 'unknown');
      const edge = classifyEdges(facts).find(e => e.id === 'clis.run -> outbox');
      assert.equal(edge.status, 'unknown');
      assert.deepEqual(edge.producerObservation, facts.producerObservation);
      assert.match(edge.detail, new RegExp(`local producer history: ${count > 100 ? 'incomplete' : `matchedEvents=${count}`}`));
      assert.match(edge.detail, /does not establish receipt or current activity/);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('producer observation rejects missing, unrelated, corrupt, and oversized records', () => {
  const missing = producerFixture();
  try {
    const facts = collectFacts({ clisDb: join(missing.dir, 'missing'), valveDb: join(missing.dir, 'missing-consumer') });
    assert.equal(facts.producerObservation.status, 'unknown');
    assert.match(classifyEdges(facts).find(e => e.id === 'clis.run -> outbox').detail, /local producer history: unknown/);
  }
  finally { rmSync(missing.dir, { recursive: true, force: true }); }
  for (const sql of [
    "DELETE FROM clis_meta", "UPDATE clis_meta SET value='invalid'", "UPDATE clis_events SET payload_hash='bad'",
    "UPDATE clis_events SET payload='not json'", "UPDATE clis_outbox SET event_id='00000000-0000-4000-8000-000000000000'",
    "DELETE FROM clis_outbox", "UPDATE clis_outbox SET status='delivered'",
    "UPDATE clis_events SET payload=replace(hex(zeroblob(40000)),'00','xx')",
    'DROP TABLE clis_outbox',
  ]) {
    const f = producerFixture(1);
    try { changeProducer(f, sql); assert.equal(observation(f).status, 'unknown', sql); }
    finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('no receipts is no_data and details never show undefined or null', () => {
  const f = fixture();
  try {
    const facts = collectFacts({ clisDb: f.clisDb, valveDb: f.valveDb });
    assert.equal(status(facts), 'no_data');
    assert.ok(classifyEdges(facts).every(e => !/\b(?:undefined|null)\b/.test(e.detail)));
  } finally { close(f); }
});
