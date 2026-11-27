import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { isAbsolute, parse, resolve, sep } from 'node:path';

import { TECHNICAL_REVIEW_ALGORITHM_VERSION as version, validId, validSnapshot } from './technical-review-contract.js';

const maxFile = 64 * 1024 * 1024;
const safety = Object.freeze({ goalProof: 'not_evaluated', principleAttribution: 'not_evaluated', governanceEligible: false });
const result = (status, reason) => ({ status, reason, ...safety });

function safeFile(path, required) {
  let info;
  try { info = lstatSync(path); } catch (error) {
    if (error.code === 'ENOENT' && !required) return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxFile) throw new Error('unsafe');
  return info.size;
}

function preflight(filePath) {
  const root = parse(filePath).root;
  const parts = filePath.slice(root.length).split(sep);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('unsafe');
  }
  const mainSize = safeFile(filePath, false);
  if (mainSize === null) return false;
  const walSize = safeFile(`${filePath}-wal`, false) ?? 0;
  if (mainSize + walSize > maxFile) throw new Error('unsafe');
  safeFile(`${filePath}-shm`, false);
  safeFile(`${filePath}-journal`, false);
  return true;
}

/** Read a stored snapshot using a trusted, private absolute host path. */
export function readTechnicalReview(options) {
  try {
    if (!options || Object.getPrototypeOf(options) !== Object.prototype
      || Reflect.ownKeys(options).length !== 3 || !['filePath', 'producerId', 'eventId'].every((key) => Object.hasOwn(options, key))) return result('error', 'invalid_request');
    const { filePath, producerId, eventId } = options;
    if (typeof filePath !== 'string' || !isAbsolute(filePath) || filePath.length > 4096
      || filePath.includes('\0') || /^file:/i.test(filePath) || resolve(filePath) !== filePath
      || !validId(producerId) || !validId(eventId)) return result('error', 'invalid_request');
    try {
      if (!preflight(filePath)) return result('missing', 'database_missing');
    } catch { return result('unknown', 'database_unavailable'); }
    let db;
    try {
      db = new DatabaseSync(filePath, { readOnly: true });
      const rows = db.prepare(`SELECT
        CASE WHEN typeof(data)='text' AND length(CAST(data AS BLOB)) <= 2048
          THEN CAST(data AS BLOB) ELSE NULL END AS data,
        typeof(producer_id) AS producer_type, typeof(event_id) AS event_type,
        typeof(algorithm_version) AS version_type
        FROM technical_review_snapshots
        WHERE producer_id = ? COLLATE BINARY AND event_id = ? COLLATE BINARY
          AND algorithm_version = ? COLLATE BINARY LIMIT 2`).all(producerId, eventId, version);
      if (rows.length === 0) return result('missing', 'snapshot_missing');
      if (rows.length !== 1 || !rows[0].data || rows[0].producer_type !== 'text'
        || rows[0].event_type !== 'text' || rows[0].version_type !== 'text') return result('error', 'invalid_snapshot');
      let value;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(rows[0].data);
        if (text.includes('\0')) return result('error', 'invalid_snapshot');
        value = JSON.parse(text);
        if (JSON.stringify(value) !== text) return result('error', 'invalid_snapshot');
      } catch { return result('error', 'invalid_snapshot'); }
      if (!validSnapshot(value, producerId, eventId)) return result('error', 'invalid_snapshot');
      return { ...result('available', 'snapshot_available'), snapshot: value };
    } catch { return result('error', 'database_read_error'); }
    finally { try { db?.close(); } catch {} }
  } catch { return result('error', 'invalid_request'); }
}
