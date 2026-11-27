import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { types } from 'node:util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (code) => Object.assign(new Error(code), { code });
const digest = (s) => createHash('sha256').update(s).digest('hex');
const isObject = (v) => v !== null && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;

// Canonical JSON prevents key order from changing event identity.
function canonical(value, depth = 0) {
  if (depth > 20) throw fail('invalid_payload');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (value === null || typeof value !== 'object' || types.isProxy(value)) throw fail('invalid_payload');
  const array = Array.isArray(value);
  if (!array && !isObject(value)) throw fail('invalid_payload');
  if (array && Object.getPrototypeOf(value) !== Array.prototype) throw fail('invalid_payload');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) throw fail('invalid_payload');
  if (array) {
    const length = descriptors.length?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > 65536 || keys.length !== length + 1) throw fail('invalid_payload');
    const parts = [];
    for (let i = 0; i < length; i++) {
      const descriptor = descriptors[String(i)];
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail('invalid_payload');
      parts.push(canonical(descriptor.value, depth + 1));
    }
    return '[' + parts.join(',') + ']';
  }
  keys.sort();
  return '{' + keys.map((key) => {
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw fail('invalid_payload');
    return JSON.stringify(key) + ':' + canonical(descriptor.value, depth + 1);
  }).join(',') + '}';
}
function encode(value) {
  const text = canonical(value);
  if (Buffer.byteLength(text) > 65536) throw fail('invalid_payload');
  return text;
}
function validId(id) { if (typeof id !== 'string' || !UUID.test(id)) throw fail('invalid_event_id'); }
export function newClisEventId() { return randomUUID(); }

const classifications = new Set(['unsupported_kind', 'invalid_run_payload', 'baseline_unassociated_feedback', 'pending_failure_review', 'caller_declared_achieved', 'baseline', 'not_tried', 'not_provided']);
function validateFeedback(input) {
  if (!isObject(input) || Object.keys(input).sort().join(',') !== 'classification,eventId,producerId,receiptId,schemaVersion' || input.schemaVersion !== 1 || !classifications.has(input.classification)) throw fail('invalid_feedback');
  for (const id of [input.producerId, input.eventId, input.receiptId]) validId(id);
}

function checkReceiptBinding(db, input) {
  const row = db.prepare(`SELECT r.event_id,r.evidence,r.evidence_hash,e.kind,e.payload,e.created_at,e.seq,e.payload_hash
    FROM clis_receipts r JOIN clis_events e ON r.event_id=e.event_id WHERE r.receipt_id=?`).get(input.receiptId);
  if (!row) throw fail('receipt_not_found');
  if (digest(row.evidence) !== row.evidence_hash || digest(JSON.stringify([input.producerId, row.event_id, row.kind, row.payload, row.created_at, row.seq])) !== row.payload_hash) throw fail('corrupt_receipt_binding');
  const evidence = JSON.parse(row.evidence);
  if (row.event_id !== input.eventId || evidence?.producerId !== input.producerId || evidence.eventId !== input.eventId || evidence.receiptId !== input.receiptId || evidence.status !== 'received' || evidence.authenticated !== false || evidence.governanceEligible !== false || evidence.kind !== row.kind || encode(evidence.payload) !== row.payload) throw fail('receipt_identity_mismatch');
}

// Query through a separate read-only connection, including before the first writer opens.
export function readClisFeedback(filePath, producerId, eventId) {
  validId(producerId); validId(eventId);
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) throw fail('invalid_store_path');
  const db = new DatabaseSync(filePath, { readOnly: true });
  try {
    db.exec('BEGIN');
    if (db.prepare("SELECT value FROM clis_meta WHERE key='producer_id'").get()?.value !== producerId) throw fail('producer_mismatch');
    if (!db.prepare('SELECT 1 FROM clis_events WHERE event_id=?').get(eventId)) return { status: 'event_not_found' };
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='clis_feedback_v1'").get()) return { status: 'feedback_schema_unavailable' };
    const row = db.prepare('SELECT evidence,evidence_hash FROM clis_feedback_v1 WHERE event_id=?').get(eventId);
    if (!row) return { status: 'feedback_not_observed' };
    if (digest(row.evidence) !== row.evidence_hash) throw fail('corrupt_feedback');
    const feedback = JSON.parse(row.evidence);
    validateFeedback(feedback);
    if (feedback.producerId !== producerId || feedback.eventId !== eventId) throw fail('corrupt_feedback');
    checkReceiptBinding(db, feedback);
    return { status: 'recorded', ...feedback, authenticated: false, humanAdoption: 'unknown', principleAttribution: 'unknown', governanceEligible: false };
  } finally { db.close(); }
}

// This store is isolated and does not authenticate callers or receiver claims.
export function openClisEventStore(filePath) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.includes('\0')) throw fail('invalid_store_path');
  const db = new DatabaseSync(filePath);
  try {
    db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw fail('corrupt_store');
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS clis_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS clis_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS clis_outbox (event_id TEXT PRIMARY KEY REFERENCES clis_events(event_id), status TEXT NOT NULL CHECK(status='pending')) STRICT;
      CREATE TABLE IF NOT EXISTS clis_feedback_v1 (event_id TEXT PRIMARY KEY REFERENCES clis_events(event_id), evidence TEXT NOT NULL, evidence_hash TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS clis_receipts (receipt_id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES clis_events(event_id), evidence TEXT NOT NULL, evidence_hash TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;`);
    db.prepare("INSERT OR IGNORE INTO clis_meta VALUES ('producer_id', ?)").run(randomUUID());
    const producerId = db.prepare("SELECT value FROM clis_meta WHERE key='producer_id'").get()?.value;
    if (!UUID.test(producerId ?? '')) throw fail('corrupt_store');
    if (db.prepare('PRAGMA foreign_key_check').get() || db.prepare('SELECT 1 FROM clis_events e LEFT JOIN clis_outbox o ON e.event_id=o.event_id WHERE o.event_id IS NULL LIMIT 1').get()) throw fail('corrupt_store');
    db.exec('COMMIT');
    let closed = false;
    function check() { if (closed) throw fail('store_closed'); }
    function transaction(fn) {
      let active = false;
      try { db.exec('BEGIN IMMEDIATE'); active = true; const result = fn(); db.exec('COMMIT'); active = false; return result; }
      catch (error) { if (active) { try { db.exec('ROLLBACK'); } catch {} } throw error; }
    }
    // The digest detects unsynchronized changes, not an attacker who can rewrite it.
    const eventHash = (id, kind, payload, createdAt, sequence) => digest(JSON.stringify([producerId, id, kind, payload, createdAt, sequence]));
    function rowToEvent(row) {
      if (!row) return null;
      if (!UUID.test(row.event_id) || !/^[a-z][a-z0-9_.-]{0,127}$/.test(row.kind) || !Number.isSafeInteger(row.seq) || row.seq < 1 || row.status !== 'pending' || eventHash(row.event_id, row.kind, row.payload, row.created_at, row.seq) !== row.payload_hash) throw fail('corrupt_event');
      let payload;
      try { payload = JSON.parse(row.payload); if (encode(payload) !== row.payload) throw new Error(); } catch { throw fail('corrupt_event'); }
      return { producerId, eventId: row.event_id, kind: row.kind, payload, payloadHash: row.payload_hash, createdAt: row.created_at, sequence: row.seq, deliveryStatus: 'pending' };
    }
    const select = 'SELECT e.seq,e.event_id,e.kind,e.payload,e.payload_hash,e.created_at,o.status FROM clis_events e LEFT JOIN clis_outbox o ON e.event_id=o.event_id';
    const lookup = (id) => rowToEvent(db.prepare(select + ' WHERE e.event_id=?').get(id));
    return Object.freeze({
      producerId,
      record(input) {
        check();
        input = JSON.parse(encode(input));
        if (!isObject(input) || Object.keys(input).sort().join(',') !== 'eventId,kind,payload') throw fail('invalid_event');
        validId(input.eventId);
        if (typeof input.kind !== 'string' || !/^[a-z][a-z0-9_.-]{0,127}$/.test(input.kind)) throw fail('invalid_event');
        const data = encode(input.payload);
        return transaction(() => {
          const prior = lookup(input.eventId);
          if (prior) {
            if (prior.kind !== input.kind || encode(prior.payload) !== data) throw fail('event_conflict');
            return { status: 'replay', event: prior };
          }
          const createdAt = new Date().toISOString();
          const result = db.prepare('INSERT INTO clis_events(event_id,kind,payload,payload_hash,created_at) VALUES(?,?,?,?,?)').run(input.eventId, input.kind, data, '', createdAt);
          const sequence = Number(result.lastInsertRowid);
          if (!Number.isSafeInteger(sequence) || sequence < 1) throw fail('invalid_sequence');
          const hash = eventHash(input.eventId, input.kind, data, createdAt, sequence);
          db.prepare('UPDATE clis_events SET payload_hash=? WHERE event_id=?').run(hash, input.eventId);
          db.prepare("INSERT INTO clis_outbox(event_id,status) VALUES(?,'pending')").run(input.eventId);
          return { status: 'created', event: lookup(input.eventId) };
        });
      },
      get(eventId) { check(); validId(eventId); return lookup(eventId); },
      pending({ limit = 50, after = 0 } = {}) {
        check();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < 0) throw fail('invalid_scan');
        return db.prepare(select + ' WHERE e.seq>? ORDER BY e.seq LIMIT ?').all(after, limit).map(rowToEvent);
      },
      recordReceipt(input) {
        check();
        input = JSON.parse(encode(input));
        if (!isObject(input) || Object.keys(input).sort().join(',') !== 'eventId,evidence,receiptId') throw fail('invalid_receipt');
        const { receiptId, eventId, evidence } = input;
        validId(receiptId); validId(eventId);
        const data = encode(evidence); const hash = digest(data);
        return transaction(() => {
          if (!lookup(eventId)) throw fail('event_not_found');
          const prior = db.prepare('SELECT event_id,evidence,evidence_hash FROM clis_receipts WHERE receipt_id=?').get(receiptId);
          if (prior) {
            if (digest(prior.evidence) !== prior.evidence_hash) throw fail('corrupt_receipt');
            if (prior.event_id !== eventId || prior.evidence !== data || prior.evidence_hash !== hash) throw fail('receipt_conflict');
            return { status: 'replay', authenticated: false };
          }
          db.prepare('INSERT INTO clis_receipts VALUES(?,?,?,?,?)').run(receiptId, eventId, data, hash, new Date().toISOString());
          return { status: 'recorded', authenticated: false };
        });
      },
      recordFeedback(input) {
        check();
        const data = encode(input);
        input = JSON.parse(data);
        validateFeedback(input);
        if (input.producerId !== producerId) throw fail('producer_mismatch');
        return transaction(() => {
          checkReceiptBinding(db, input);
          const prior = db.prepare('SELECT evidence,evidence_hash FROM clis_feedback_v1 WHERE event_id=?').get(input.eventId);
          if (prior) {
            if (digest(prior.evidence) !== prior.evidence_hash) throw fail('corrupt_feedback');
            if (prior.evidence !== data) throw fail('feedback_conflict');
            return { status: 'replay' };
          }
          db.prepare('INSERT INTO clis_feedback_v1 VALUES(?,?,?)').run(input.eventId, data, digest(data));
          return { status: 'recorded' };
        });
      },
      receipts(eventId, { limit = 50, after = 0 } = {}) {
        check(); validId(eventId);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(after) || after < 0) throw fail('invalid_scan');
        return db.prepare('SELECT rowid AS seq,receipt_id,evidence,evidence_hash,created_at FROM clis_receipts WHERE event_id=? AND rowid>? ORDER BY rowid LIMIT ?').all(eventId, after, limit).map((row) => {
          if (!UUID.test(row.receipt_id) || digest(row.evidence) !== row.evidence_hash) throw fail('corrupt_receipt');
          let evidence; try { evidence = JSON.parse(row.evidence); if (encode(evidence) !== row.evidence) throw new Error(); } catch { throw fail('corrupt_receipt'); }
          return { sequence: row.seq, receiptId: row.receipt_id, eventId, evidence, createdAt: row.created_at, authenticated: false };
        });
      },
      markDelivered() { check(); throw fail('trusted_delivery_evidence_unavailable'); },
      close() { if (!closed) { db.close(); closed = true; } },
    });
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} try { db.close(); } catch {} throw error; }
}
