import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';

import { TECHNICAL_REVIEW_ALGORITHM_VERSION, validId, validIdentityReason, validArtifact, noPromotion, validSnapshot } from './technical-review-contract.js';
export { TECHNICAL_REVIEW_ALGORITHM_VERSION } from './technical-review-contract.js';

function failure(code) { return Object.assign(new Error(code), { code }); }
function exactRequest(value) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === 2 && validId(value.producerId) && validId(value.eventId);
}
function canonical(value, ancestors = [], depth = 0) {
  if (depth > 64) throw failure('invalid_technical_evidence');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || ancestors.includes(value)) throw failure('invalid_technical_evidence');
  const stack = [...ancestors, value];
  if (Array.isArray(value)) return `[${Array.from(value, (item) => item === undefined ? 'null' : canonical(item, stack, depth + 1)).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw failure('invalid_technical_evidence');
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], stack, depth + 1)}`).join(',')}}`;
}
function snapshot(request, evidence) {
  const identity = evidence?.identity;
  const artifacts = evidence?.artifacts;
  if (!noPromotion(identity) || !noPromotion(artifacts) || identity.producerId !== request.producerId
    || identity.eventId !== request.eventId || identity.status !== 'match' || !validIdentityReason(identity.code)
    || identity.attestation !== 'record_consistency' || !validArtifact(artifacts.status, artifacts.reason)
    || !identity.payload || typeof identity.payload !== 'object' || Array.isArray(identity.payload)) throw failure('invalid_technical_evidence');
  const json = canonical(identity.payload);
  if (Buffer.byteLength(json) > 16 * 1024) throw failure('invalid_technical_evidence');
  return { producerId: request.producerId, eventId: request.eventId,
    payloadSha256: createHash('sha256').update(json).digest('hex'), algorithmVersion: TECHNICAL_REVIEW_ALGORITHM_VERSION,
    identityStatus: identity.status, identityReason: identity.code,
    artifactStatus: artifacts.status, artifactReason: artifacts.reason,
    goalProof: 'not_evaluated', principleAttribution: 'not_evaluated', governanceEligible: false };
}
function parseRow(row) {
  if (!row || typeof row.data !== 'string' || Buffer.byteLength(row.data) > 2048) throw failure('corrupt_technical_review');
  let value;
  try { value = JSON.parse(row.data); } catch { throw failure('corrupt_technical_review'); }
  if (!validSnapshot(value)) throw failure('corrupt_technical_review');
  return value;
}

/** Host-private configuration; resolveEvidence must invoke trusted internal readers. */
export function createTechnicalReviewStore({ filePath, resolveEvidence } = {}) {
  if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.includes('\0') || filePath.length > 4096
    || typeof resolveEvidence !== 'function') throw failure('invalid_technical_review_config');
  let db;
  try {
    db = new DatabaseSync(filePath);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS technical_review_snapshots (
        producer_id TEXT NOT NULL, event_id TEXT NOT NULL, algorithm_version TEXT NOT NULL,
        data TEXT NOT NULL CHECK(length(CAST(data AS BLOB)) <= 2048),
        PRIMARY KEY(producer_id,event_id,algorithm_version));`);
    db.prepare('SELECT producer_id,event_id,algorithm_version,data FROM technical_review_snapshots LIMIT 0');
  } catch { try { db?.close(); } catch {} throw failure('technical_review_database_error'); }
  let closed = false;
  function check() { if (closed) throw failure('technical_review_closed'); }
  function lookup(request) {
    const row = db.prepare(`SELECT CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) <= 2048
      THEN CAST(data AS BLOB) ELSE NULL END AS data FROM technical_review_snapshots
      WHERE producer_id=? AND event_id=? AND algorithm_version=?`).get(request.producerId, request.eventId, TECHNICAL_REVIEW_ALGORITHM_VERSION);
    if (!row) return null;
    if (!row.data) throw failure('corrupt_technical_review');
    const value = parseRow({ data: Buffer.from(row.data).toString('utf8') });
    if (value.producerId !== request.producerId || value.eventId !== request.eventId) throw failure('corrupt_technical_review');
    return value;
  }
  function wrap(error) {
    if (['corrupt_technical_review','technical_review_conflict','invalid_technical_evidence'].includes(error?.code)) throw error;
    throw failure('technical_review_database_error');
  }
  return Object.freeze({
    review(request) {
      check();
      if (!exactRequest(request)) throw failure('invalid_technical_review_request');
      let evidence;
      try { evidence = resolveEvidence({ producerId: request.producerId, eventId: request.eventId }); }
      catch { throw failure('technical_review_resolver_error'); }
      let candidate;
      try { candidate = snapshot(request, evidence); } catch { throw failure('invalid_technical_evidence'); }
      let transaction = false;
      try {
        db.exec('BEGIN IMMEDIATE'); transaction = true;
        const existing = lookup(request);
        if (existing) {
          const { createdAt, ...old } = existing;
          if (JSON.stringify(old) !== JSON.stringify(candidate)) throw failure('technical_review_conflict');
          db.exec('COMMIT'); transaction = false;
          return { status: 'replay', snapshot: existing };
        }
        const value = { ...candidate, createdAt: new Date().toISOString() };
        db.prepare('INSERT INTO technical_review_snapshots VALUES (?,?,?,?)').run(request.producerId, request.eventId, TECHNICAL_REVIEW_ALGORITHM_VERSION, JSON.stringify(value));
        db.exec('COMMIT'); transaction = false;
        return { status: 'created', snapshot: value };
      } catch (error) { if (transaction) { try { db.exec('ROLLBACK'); } catch {} } wrap(error); }
    },
    get(request) {
      check();
      if (!exactRequest(request)) throw failure('invalid_technical_review_request');
      try { return lookup(request); } catch (error) { wrap(error); }
    },
    close() { if (!closed) { closed = true; try { db.close(); } catch { throw failure('technical_review_database_error'); } } },
  });
}
