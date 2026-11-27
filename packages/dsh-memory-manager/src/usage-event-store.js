import { DatabaseSync } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { canonicalObjectKey } from './object-key.js';
import { redactSecrets } from './secrets.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (code) => Object.assign(new Error(code), { code });

// Generate the id before the first write so an unknown commit can be reconciled.
export function newUsageEventId() { return randomUUID(); }

function payload(input) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
      Object.keys(input).some((k) => !['eventId', 'href', 'kind', 'note'].includes(k)) ||
      !UUID.test(input.eventId ?? '') || typeof input.href !== 'string' ||
      canonicalObjectKey(input.href) !== input.href || redactSecrets(input.href).text !== input.href ||
      !['positive', 'correction'].includes(input.kind) ||
      (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2048 || /[\x00-\x1f\x7f]/.test(input.note)))) throw fail('invalid_usage_event');
  return JSON.stringify({ href: input.href, kind: input.kind, note: redactSecrets(input.note ?? '').text });
}

/** Local bookkeeping only: a caller declaration is not authenticated user evidence. */
export function openUsageEventStore(filePath) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.includes('\0')) throw fail('invalid_store_path');
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS usage_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_events (event_id TEXT PRIMARY KEY, payload TEXT NOT NULL, payload_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS usage_outbox (event_id TEXT PRIMARY KEY REFERENCES usage_events(event_id), delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1)));
      PRAGMA foreign_keys=ON;`);
    db.prepare("INSERT OR IGNORE INTO usage_store_meta(key,value) VALUES('source_store_id',?)").run(randomUUID());
    const sourceStoreId = db.prepare("SELECT value FROM usage_store_meta WHERE key='source_store_id'").get()?.value;
    if (!UUID.test(sourceStoreId ?? '')) throw fail('invalid_source_store_id');
    let closed = false;
    function check() { if (closed) throw fail('store_closed'); }
    function lookup(id) {
      const row = db.prepare('SELECT e.event_id, e.payload, e.payload_hash, e.created_at, o.delivered FROM usage_events e JOIN usage_outbox o ON o.event_id=e.event_id WHERE e.event_id=?').get(id);
      if (!row) return null;
      if (createHash('sha256').update(row.payload).digest('hex') !== row.payload_hash) throw fail('corrupt_usage_event');
      return { sourceStoreId, eventId: row.event_id, ...JSON.parse(row.payload), payloadHash: row.payload_hash, createdAt: row.created_at, deliveryStatus: 'unknown', legacyDeliveryClaim: row.delivered === 1, provenance: 'caller_declaration', governanceEligible: false };
    }
    return Object.freeze({
      sourceStoreId,
      record(input) {
        check();
        const data = payload(input);
        const hash = createHash('sha256').update(data).digest('hex');
        let transaction = false;
        try {
          db.exec('BEGIN IMMEDIATE'); transaction = true;
          const prior = lookup(input.eventId);
          if (prior) {
            if (prior.payloadHash !== hash || JSON.stringify({ href: prior.href, kind: prior.kind, note: prior.note }) !== data) throw fail('usage_event_conflict');
            db.exec('COMMIT'); transaction = false;
            return { status: 'replay', event: prior };
          }
          db.prepare('INSERT INTO usage_events VALUES (?,?,?,?)').run(input.eventId, data, hash, new Date().toISOString());
          db.prepare('INSERT INTO usage_outbox(event_id) VALUES (?)').run(input.eventId);
          db.exec('COMMIT'); transaction = false;
          return { status: 'created', event: lookup(input.eventId) };
        } catch (error) {
          if (transaction) { try { db.exec('ROLLBACK'); } catch {} }
          throw error;
        }
      },
      // Caller-supplied receipts cannot establish trusted delivery.
      markDelivered() {
        check();
        throw fail('trusted_delivery_evidence_unavailable');
      },
      get(eventId) { check(); if (!UUID.test(eventId ?? '')) throw fail('invalid_usage_event'); return lookup(eventId); },
      pending(limit = 50) {
        check();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('invalid_limit');
        return db.prepare('SELECT event_id FROM usage_outbox ORDER BY rowid LIMIT ?').all(limit).map((row) => lookup(row.event_id));
      },
      close() { if (!closed) { db.close(); closed = true; } },
    });
  } catch (error) { try { db.close(); } catch {} throw error; }
}
