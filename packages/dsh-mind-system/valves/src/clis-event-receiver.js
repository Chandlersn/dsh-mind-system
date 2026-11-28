import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { CAUSAL_TYPES } from './clis-bridge.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KIND = /^[a-z][a-z0-9_.-]{0,127}$/;
const fail = (code) => Object.assign(new Error(code), { code });
const hash = (text) => createHash('sha256').update(text).digest('hex');
const plain = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// Accept only JSON values that can be serialized without silently changing them.
function canonical(v, depth = 0) {
  if (depth > 20) throw fail('invalid_payload');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) {
    const keys = Reflect.ownKeys(v);
    if (keys.length !== v.length + 1 || keys[keys.length - 1] !== 'length') throw fail('invalid_payload');
    for (let i = 0; i < v.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(v, String(i));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw fail('invalid_payload');
    }
    return '[' + Array.from(v, (item) => canonical(item, depth + 1)).join(',') + ']';
  }
  if (!plain(v) || Object.getOwnPropertySymbols(v).length) throw fail('invalid_payload');
  const descriptors = Object.getOwnPropertyDescriptors(v);
  if (Object.values(descriptors).some((d) => !d.enumerable || !('value' in d))) throw fail('invalid_payload');
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(descriptors[k].value, depth + 1)).join(',') + '}';
}
function encode(v) {
  const text = canonical(v);
  if (Buffer.byteLength(text, 'utf8') > 65536) throw fail('invalid_payload');
  return text;
}
function validId(v) { return typeof v === 'string' && UUID.test(v); }
function validTime(v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v; }
function normalize(input) {
  if (!plain(input) || Object.getOwnPropertySymbols(input).length || Object.keys(input).sort().join(',') !== 'eventId,kind,payload,producerId') throw fail('invalid_event');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Object.values(descriptors).some((d) => !d.enumerable || !('value' in d))) throw fail('invalid_event');
  const { producerId, eventId, kind, payload } = input;
  if (!validId(producerId) || !validId(eventId) || typeof kind !== 'string' || !KIND.test(kind)) throw fail('invalid_event');
  const data = encode(payload);
  return { producerId, eventId, kind, data, digest: hash(JSON.stringify(kind) + ':' + data) };
}

function classify(kind, payload) {
  if (kind !== 'clis.run.v1') return 'unsupported_kind';
  if (!plain(payload) || payload.schemaVersion !== 1 || payload.source !== 'clis_run' ||
      typeof payload.baseline !== 'boolean' || !CAUSAL_TYPES.includes(payload.causalType) ||
      !['effective', 'ineffective', 'type_misjudged', 'unknown'].includes(payload.planSignal) || !plain(payload.feedback)) return 'invalid_run_payload';
  const { outcome, association } = payload.feedback;
  if (outcome === 'failed' || outcome === 'achieved') {
    if (association !== (payload.baseline ? 'no_prior_history' : 'prior_history')) return 'invalid_run_payload';
    if (payload.baseline) return 'baseline_unassociated_feedback';
    return outcome === 'failed' ? 'pending_failure_review' : 'caller_declared_achieved';
  }
  if (!['not_tried', 'not_provided'].includes(outcome) || association !== 'none') return 'invalid_run_payload';
  return payload.baseline ? 'baseline' : outcome;
}

// Switching a fresh store to WAL takes an exclusive lock that busy_timeout does
// not cover. Concurrent receivers can therefore hit SQLITE_BUSY on this PRAGMA
// even though every later write is serialized. Retry ONLY that transition, with
// a bounded backoff; all other errors remain unchanged and still fail closed.
const WAL_RETRIES = 6;
const isBusy = (error) => error?.code === 'ERR_SQLITE_ERROR' && error?.errcode === 5
  || /database is locked|SQLITE_BUSY/i.test(String(error?.message ?? ''));
function setWal(db) {
  for (let attempt = 0; ; attempt++) {
    try { db.exec('PRAGMA journal_mode=WAL;'); return; }
    catch (error) {
      if (!isBusy(error) || attempt >= WAL_RETRIES - 1) throw error;
      // Synchronous busy-wait: the receiver API is synchronous and must not
      // depend on timers or an active event loop.
      const until = Date.now() + (attempt + 1) * 10;
      while (Date.now() < until) { /* bounded spin */ }
    }
  }
}

// Keep consumption outside the receipt: older producers compare receipt evidence byte for byte.
export function createClisEventReceiver({ filePath } = {}) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.includes('\0')) throw fail('invalid_store_path');
  const db = new DatabaseSync(filePath);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    setWal(db);
    db.exec('PRAGMA synchronous=FULL;');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fail('corrupt_store');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS clis_event_inbox (producer_id TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(producer_id,event_id)) STRICT;
      CREATE TABLE IF NOT EXISTS clis_event_results (producer_id TEXT NOT NULL, event_id TEXT NOT NULL, receipt_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL CHECK(status='received'), PRIMARY KEY(producer_id,event_id), FOREIGN KEY(producer_id,event_id) REFERENCES clis_event_inbox(producer_id,event_id)) STRICT;`);
    if (db.prepare('PRAGMA foreign_key_check').get() || db.prepare('SELECT 1 FROM clis_event_inbox e LEFT JOIN clis_event_results r ON e.producer_id=r.producer_id AND e.event_id=r.event_id WHERE r.event_id IS NULL LIMIT 1').get()) throw fail('corrupt_store');
    db.exec(`CREATE TABLE IF NOT EXISTS clis_consumption_v1 (producer_id TEXT NOT NULL, event_id TEXT NOT NULL, classification TEXT NOT NULL, PRIMARY KEY(producer_id,event_id), FOREIGN KEY(producer_id,event_id) REFERENCES clis_event_inbox(producer_id,event_id)) STRICT;
      CREATE INDEX IF NOT EXISTS clis_review_class ON clis_consumption_v1(classification);
      CREATE TABLE IF NOT EXISTS clis_recovery_v1 (id INTEGER PRIMARY KEY CHECK(id=1), after_receipt INTEGER NOT NULL CHECK(after_receipt>=0)) STRICT;
      INSERT OR IGNORE INTO clis_recovery_v1 VALUES(1,0);`);
    let closed = false;
    function check() { if (closed) throw fail('receiver_closed'); }
    function transaction(fn) {
      let active = false;
      try { db.exec('BEGIN IMMEDIATE'); active = true; const result = fn(); db.exec('COMMIT'); active = false; return result; }
      catch (error) { if (active) { try { db.exec('ROLLBACK'); } catch {} } throw error; }
    }
    const receiptColumns = 'e.producer_id,e.event_id,e.kind,e.payload,e.payload_hash,e.received_at,r.receipt_id,r.status';
    const receiptTables = ' FROM clis_event_inbox e LEFT JOIN clis_event_results r ON e.producer_id=r.producer_id AND e.event_id=r.event_id';
    const select = `SELECT ${receiptColumns}${receiptTables}`;
    function decode(row) {
      if (!row) return null;
      if (!validId(row.producer_id) || !validId(row.event_id) || typeof row.kind !== 'string' || !KIND.test(row.kind) || !validId(row.receipt_id) || row.status !== 'received' || !validTime(row.received_at) || typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > 65536 || hash(JSON.stringify(row.kind) + ':' + row.payload) !== row.payload_hash) throw fail('corrupt_event');
      let payload;
      try { payload = JSON.parse(row.payload); if (encode(payload) !== row.payload) throw new Error(); } catch { throw fail('corrupt_event'); }
      return { producerId: row.producer_id, eventId: row.event_id, kind: row.kind, payload, receivedAt: row.received_at, receiptId: row.receipt_id, status: 'received', authenticated: false, governanceEligible: false };
    }
    function lookup(producerId, eventId) { return decode(db.prepare(select + ' WHERE e.producer_id=? AND e.event_id=?').get(producerId, eventId)); }
    const insert = db.prepare('INSERT INTO clis_consumption_v1 VALUES(?,?,?)');
    function consume(receipt) {
      insert.run(receipt.producerId, receipt.eventId, classify(receipt.kind, receipt.payload));
    }
    const findResult = db.prepare('SELECT classification FROM clis_consumption_v1 WHERE producer_id=? AND event_id=?');
    function resultFor(receipt, classification = findResult.get(receipt.producerId, receipt.eventId)?.classification) {
      if (classification !== classify(receipt.kind, receipt.payload)) throw fail('corrupt_consumption');
      return { producerId: receipt.producerId, eventId: receipt.eventId, classification, authenticated: false, principleAttribution: 'unknown', governanceEligible: false };
    }
    // Receipt rowids increase under both old and current append-only writers. Commit the cursor with its page.
    const cursor = db.prepare('SELECT after_receipt FROM clis_recovery_v1 WHERE id=1');
    const scan = db.prepare('SELECT rowid,producer_id,event_id FROM clis_event_results WHERE rowid>? ORDER BY rowid LIMIT 50');
    const pending = db.prepare('SELECT 1 FROM clis_event_results WHERE rowid>? LIMIT 1');
    function recoverPage() {
      const rows = scan.all(cursor.get().after_receipt);
      for (const row of rows) {
        if (!findResult.get(row.producer_id, row.event_id)) consume(lookup(row.producer_id, row.event_id));
      }
      if (rows.length) db.prepare('UPDATE clis_recovery_v1 SET after_receipt=? WHERE id=1').run(rows.at(-1).rowid);
    }
    recoverPage();
    db.exec('COMMIT');
    return Object.freeze({
      receive(input) {
        check(); const event = normalize(input);
        return transaction(() => {
          const prior = lookup(event.producerId, event.eventId);
          if (prior) {
            if (prior.kind !== event.kind || encode(prior.payload) !== event.data) throw fail('event_conflict');
            if (!findResult.get(prior.producerId, prior.eventId)) consume(prior);
            resultFor(prior);
            return { status: 'replay', receipt: prior };
          }
          db.prepare('INSERT INTO clis_event_inbox VALUES(?,?,?,?,?,?)').run(event.producerId, event.eventId, event.kind, event.data, event.digest, new Date().toISOString());
          db.prepare("INSERT INTO clis_event_results VALUES(?,?,?,'received')").run(event.producerId, event.eventId, randomUUID());
          const receipt = lookup(event.producerId, event.eventId);
          consume(receipt);
          resultFor(receipt);
          return { status: 'received', receipt };
        });
      },
      get(producerId, eventId) { check(); if (!validId(producerId) || !validId(eventId)) throw fail('invalid_event'); return lookup(producerId, eventId); },
      recover() { check(); return transaction(recoverPage); },
      consumption(producerId, eventId) {
        check();
        if (!validId(producerId) || !validId(eventId)) throw fail('invalid_event');
        const receipt = lookup(producerId, eventId);
        if (!receipt) return null;
        const classification = findResult.get(producerId, eventId)?.classification;
        if (classification === undefined && db.prepare('SELECT 1 FROM clis_event_results WHERE producer_id=? AND event_id=? AND rowid>?').get(producerId, eventId, cursor.get().after_receipt)) throw fail('recovery_pending');
        return resultFor(receipt, classification);
      },
      reviewCandidates({ after = 0, limit = 50 } = {}) {
        check();
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('invalid_scan');
        const rows = db.prepare(`SELECT ${receiptColumns},c.classification,c.rowid AS position${receiptTables}
          JOIN clis_consumption_v1 c ON e.producer_id=c.producer_id AND e.event_id=c.event_id
          WHERE c.classification='pending_failure_review' AND c.rowid>? ORDER BY c.rowid LIMIT ?`).all(after, limit + 1);
        const items = rows.slice(0, limit).map(row => resultFor(decode(row), row.classification));
        const next = rows.length > limit ? rows[limit - 1].position : null;
        return { status: 'available', items, next, recoveryScanPending: Boolean(pending.get(cursor.get().after_receipt)) };
      },
      close() { if (!closed) { db.close(); closed = true; } },
    });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} try { db.close(); } catch {} throw error; }
}
