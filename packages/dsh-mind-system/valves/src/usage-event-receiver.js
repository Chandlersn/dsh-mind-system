import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const fail = (code) => Object.assign(new Error(code), { code });

function normalize(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      !UUID.test(input.sourceStoreId ?? '') || !UUID.test(input.eventId ?? '') ||
      typeof input.href !== 'string' || !input.href || input.href.length > 4096 ||
      !['positive', 'correction'].includes(input.kind) ||
      typeof input.note !== 'string' || input.note.length > 2048 || /[\x00-\x1f\x7f]/.test(input.note) ||
      typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt)) ||
      new Date(input.createdAt).toISOString() !== input.createdAt || !HASH.test(input.payloadHash ?? '')) {
    throw fail('invalid_usage_event');
  }
  const payload = JSON.stringify({ href: input.href, kind: input.kind, note: input.note });
  const hash = createHash('sha256').update(payload, 'utf8').digest('hex');
  if (hash !== input.payloadHash) throw fail('usage_event_hash_mismatch');
  return { sourceStoreId: input.sourceStoreId, eventId: input.eventId, payload, payloadHash: hash, createdAt: input.createdAt };
}

function rowEvent(row) {
  if (!row) return null;
  const hash = createHash('sha256').update(row.payload, 'utf8').digest('hex');
  if (hash !== row.payload_hash) throw fail('corrupt_usage_event');
  let payload;
  try { payload = JSON.parse(row.payload); } catch { throw fail('corrupt_usage_event'); }
  const event = { sourceStoreId: row.source_store_id, eventId: row.event_id, ...payload,
    payloadHash: row.payload_hash, createdAt: row.created_at, provenance: 'caller_declaration', governanceEligible: false };
  try {
    if (normalize(event).payload !== row.payload) throw fail('corrupt_usage_event');
  } catch { throw fail('corrupt_usage_event'); }
  return event;
}

/** Stores caller declarations; neither authentication nor governance eligibility is inferred. */
export function openUsageEventReceiver(filePath) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.includes('\0')) throw fail('invalid_store_path');
  let db;
  try {
    db = new DatabaseSync(filePath);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS received_usage_events (
        source_store_id TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL,
        payload_hash TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(source_store_id, event_id));`);
  } catch (error) { try { db?.close(); } catch {} throw error; }
  let closed = false;
  const check = () => { if (closed) throw fail('receiver_closed'); };
  const lookup = (sourceStoreId, eventId) => rowEvent(db.prepare('SELECT * FROM received_usage_events WHERE source_store_id=? AND event_id=?').get(sourceStoreId, eventId));
  return Object.freeze({
    receive(input) {
      check();
      const value = normalize(input);
      let active = false;
      try {
        db.exec('BEGIN IMMEDIATE'); active = true;
        const existing = lookup(value.sourceStoreId, value.eventId);
        if (existing) {
          if (JSON.stringify({ href: existing.href, kind: existing.kind, note: existing.note }) !== value.payload ||
              existing.payloadHash !== value.payloadHash || existing.createdAt !== value.createdAt) throw fail('usage_event_conflict');
          db.exec('COMMIT'); active = false;
          return { status: 'replay', event: existing };
        }
        db.prepare('INSERT INTO received_usage_events VALUES (?,?,?,?,?)').run(value.sourceStoreId, value.eventId, value.payload, value.payloadHash, value.createdAt);
        db.exec('COMMIT'); active = false;
        return { status: 'received', event: { sourceStoreId: value.sourceStoreId, eventId: value.eventId,
          ...JSON.parse(value.payload), payloadHash: value.payloadHash, createdAt: value.createdAt,
          provenance: 'caller_declaration', governanceEligible: false } };
      } catch (error) {
        // A COMMIT error can have an unknown outcome; retry by the same identity.
        if (active) { try { db.exec('ROLLBACK'); } catch {} }
        throw error;
      }
    },
    get(sourceStoreId, eventId) {
      check();
      if (!UUID.test(sourceStoreId ?? '') || !UUID.test(eventId ?? '')) throw fail('invalid_usage_event');
      return lookup(sourceStoreId, eventId);
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
