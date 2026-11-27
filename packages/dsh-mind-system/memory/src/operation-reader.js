import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const LEDGER = '.write-ledger.jsonl';
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE = 64 * 1024;
const MAX_ROWS = 10000;
const MAX_MATCHES = 256;
const MAX_RESPONSE = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validId = value => typeof value === 'string' && value.length === 36 && UUID.test(value);
const own = (value, key) => Object.hasOwn(value, key);
const bounded = (value, max) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && Buffer.byteLength(value, 'utf8') <= max && !/[\x00-\x1f\x7f]/.test(value);
const token = (value, max) => bounded(value, max) && /^[a-zA-Z0-9_.:-]+$/.test(value);
const relativeKey = value => bounded(value, 4096) && !value.includes('\\') &&
  !value.includes(':') && value.split('/').every(part => part && part !== '.' && part !== '..');

function result(status, reason, rows = [], scanComplete = false) {
  return { status, reason, scanComplete, rows, execution: 'not_observed', adoption: 'not_observed',
    coverage: 'tracked_ledger_rows_only', absenceMeansNoWrites: false };
}

// Keep only bounded metadata, without normalizing IDs, paths, or operation order.
// Optional timestamps/tools support old physical rows; missing IDs stay uncorrelated.
function metadata(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !relativeKey(row.key)) return null;
  if (own(row, 'request_id') && !validId(row.request_id)) return null;
  if (own(row, 't') && (!bounded(row.t, 32) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.t) || !Number.isFinite(Date.parse(row.t)))) return null;
  if (own(row, 'tool') && !token(row.tool, 128)) return null;
  const op = own(row, 'op') ? row.op : 'write';
  if (!['write', 'delete_intent', 'delete'].includes(op)) return null;
  if (op === 'write') {
    if (!token(row.hash, 128) || own(row, 'id') || own(row, 'to')) return null;
    if (own(row, 'bytes') && (!Number.isSafeInteger(row.bytes) || row.bytes < 0)) return null;
  } else {
    if (!token(row.id, 128) || own(row, 'hash') || own(row, 'bytes')) return null;
    if (own(row, 'to') && !relativeKey(row.to)) return null;
  }
  const output = {};
  for (const key of ['t', 'key', 'hash', 'tool', 'bytes', 'op', 'id', 'to', 'request_id']) {
    if (own(row, key)) output[key] = row[key];
  }
  return output;
}

function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode &&
    a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

/**
 * Internal host-bound reader: root must come from the caller, never a tool argument.
 * Scans raw physical rows; it cannot establish execution, adoption, or write absence.
 * Fixed-size buffers bound IO before allocation. Limits apply to all rows, including
 * unrelated/legacy rows. Any invalid tail or exhausted bound discards all matches.
 * Identity checks are best-effort for cooperative filesystems, not hostile races.
 */
export async function readOperationRows(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      !validId(input.requestId) || typeof input.root !== 'string' ||
      !input.root || input.root.includes('\0') || !path.isAbsolute(input.root)) {
    return result('error', 'invalid_input');
  }
  const { requestId } = input;
  // Remove trailing separators so lstat observes a root link itself on POSIX too.
  const root = path.resolve(input.root);
  const ledger = path.join(root, LEDGER);
  let handle;
  let rootBefore;
  let ledgerBefore;
  let stage = 'root';
  let answer;
  try {
    rootBefore = await fs.lstat(root, { bigint: true });
    if (rootBefore.isSymbolicLink() || !rootBefore.isDirectory()) return result('unknown', 'unsafe_root');
    stage = 'ledger';
    try {
      ledgerBefore = await fs.lstat(ledger, { bigint: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      // Missing is only a filesystem observation; it never proves no writes.
      const rootAfter = await fs.lstat(root, { bigint: true });
      if (!same(rootBefore, rootAfter)) return result('unknown', 'identity_changed');
      try {
        await fs.lstat(ledger, { bigint: true });
        return result('unknown', 'identity_changed');
      } catch (again) {
        if (again?.code !== 'ENOENT') throw again;
      }
      return result('missing', 'ledger_missing');
    }
    if (ledgerBefore.isSymbolicLink() || !ledgerBefore.isFile() || ledgerBefore.nlink > 1n) return result('unknown', 'unsafe_ledger');
    if (ledgerBefore.size > BigInt(MAX_BYTES)) return result('incomplete', 'byte_limit');
    // O_NONBLOCK avoids blocking on a special-file replacement where supported.
    handle = await fs.open(ledger, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !same(ledgerBefore, opened)) return result('unknown', 'identity_changed');
    const chunk = Buffer.alloc(64 * 1024);
    const line = Buffer.alloc(MAX_LINE);
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const matches = [];
    let lineLength = 0;
    let count = 0;
    let position = 0;
    // Reserve the actual success envelope, including array punctuation.
    let responseBytes = Buffer.byteLength(JSON.stringify(result('match', 'matching_rows', [], true)));
    const size = Number(opened.size);
    while (position < size && !answer) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
      if (!bytesRead) { answer = result('unknown', 'identity_changed'); break; }
      position += bytesRead;
      for (let index = 0; index < bytesRead; index++) {
        if (chunk[index] !== 10) {
          if (lineLength === MAX_LINE) { answer = result('incomplete', 'line_limit'); break; }
          line[lineLength++] = chunk[index];
          continue;
        }
        if (++count > MAX_ROWS) { answer = result('incomplete', 'row_limit'); break; }
        let row;
        try { row = metadata(JSON.parse(decoder.decode(line.subarray(0, lineLength)))); }
        catch { row = null; }
        lineLength = 0;
        if (!row) { answer = result('unknown', 'malformed_row'); break; }
        if (row.request_id !== requestId) continue;
        if (matches.length === MAX_MATCHES) { answer = result('incomplete', 'match_limit'); break; }
        responseBytes += Buffer.byteLength(JSON.stringify(row)) + (matches.length ? 1 : 0);
        if (responseBytes > MAX_RESPONSE) { answer = result('incomplete', 'response_limit'); break; }
        matches.push(row);
      }
    }
    if (!answer && lineLength) answer = result('unknown', 'truncated_line');
    if (!answer) answer = matches.length ? result('match', 'matching_rows', matches, true)
      : result('no_matching_rows', 'no_correlated_rows', [], true);
    const [rootAfter, ledgerAfter, handleAfter] = await Promise.all([
      fs.lstat(root, { bigint: true }), fs.lstat(ledger, { bigint: true }), handle.stat({ bigint: true }),
    ]);
    if (!same(rootBefore, rootAfter) || !same(ledgerBefore, ledgerAfter) || !same(opened, handleAfter)) {
      answer = result('unknown', 'identity_changed');
    }
  } catch (error) {
    answer = error?.code === 'ENOENT'
      ? result(stage === 'root' ? 'missing' : 'unknown', stage === 'root' ? 'root_missing' : 'identity_changed')
      : result('error', 'read_failed');
  } finally {
    if (handle) {
      try { await handle.close(); } catch { answer = result('error', 'close_failed'); }
    }
  }
  return answer;
}
