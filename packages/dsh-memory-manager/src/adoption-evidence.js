/**
 * Read-only, bounded, cursor-paged adoption evidence for ONE logical object.
 *
 * This is the multi-row / paged form of the `adoption` hop in object-trace:
 * only positive/correction ledger declarations for the given canonicalObjectKey
 * are returned. Recall exposure and reads are filtered out. Querying appends
 * nothing, writes nothing and changes no counters.
 *
 * The legacy provenance value 'caller/user-action' remains for compatibility;
 * it does not authenticate a user or prove the source of a historical row.
 * A correlationId is a source-supplied value, not proof of uniqueness or linkage;
 * duplicates and collisions are possible, and legacy rows have no such value.
 * Matching records do not prove actual adoption, goal achievement or principle
 * attribution and are not governance-eligible.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalObjectKey } from './object-key.js';
import { readUsageFile, usageFiles } from './usage.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE = 64 * 1024;
const MAX_ROWS = 10000;
const MAX_MATCHES = 256;
const MAX_RESPONSE = 64 * 1024;
const CURSOR_RE = /^v2:([A-Za-z0-9_-]{1,512})$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const safety = Object.freeze({
  attestation: 'adoption_signal',
  goalProof: 'not_evaluated',
  principleAttribution: 'not_evaluated',
  governanceEligible: false,
  provenance: 'caller/user-action',
  absenceMeansNoAdoption: false,
});

function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 520) throw new Error('invalid_cursor');
  // Legacy cursors do not bind a source snapshot and may contain a cleartext note.
  if (/^v1:[A-Za-z0-9+/=_-]{1,512}$/.test(cursor)) throw new Error('legacy_cursor');
  const m = CURSOR_RE.exec(cursor);
  if (!m) throw new Error('invalid_cursor');
  let data;
  try {
    const bytes = Buffer.from(m[1], 'base64url');
    if (bytes.toString('base64url') !== m[1]) throw new Error('noncanonical');
    data = JSON.parse(bytes.toString('utf8'));
  } catch { throw new Error('invalid_cursor'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || Object.keys(data).sort().join(',') !== 'd,i,r'
    || typeof data.d !== 'string' || !SHA256_RE.test(data.d)
    || typeof data.r !== 'string' || !SHA256_RE.test(data.r)
    || !Number.isSafeInteger(data.i) || data.i < 0 || data.i >= MAX_MATCHES) {
    throw new Error('invalid_cursor');
  }
  return data;
}

function encodeCursor(snapshotDigest, row, index) {
  const payload = JSON.stringify({ d: snapshotDigest, i: index, r: row.identity });
  return `v2:${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

// File identity is only a race detector, not an atomic multi-file snapshot or authentication.
function sameStat(a, b) {
  return a.isFile() && b.isFile() && !a.isSymbolicLink() && !b.isSymbolicLink()
    && a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function sourceStat(file) {
  const stat = await fs.lstat(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile()) throw Object.assign(new Error('unsafe source'), { code: 'USAGE_LINK_NOT_ALLOWED' });
  if (stat.size > BigInt(MAX_BYTES)) throw Object.assign(new Error('source too large'), { code: 'USAGE_DECOMPRESSED_LIMIT' });
  return stat;
}

function sourceError(error) {
  return error?.code === 'USAGE_AMBIGUOUS_MONTH' ? 'ambiguous_sources'
    : error?.code === 'USAGE_LINK_NOT_ALLOWED' ? 'unsafe_source'
    : error?.code === 'USAGE_ENUMERATION_LIMIT' || error?.code === 'USAGE_FILE_LIMIT' ? 'source_limit'
    : error?.code === 'USAGE_DECOMPRESSED_LIMIT' ? 'file_too_large'
    : error?.code === 'USAGE_SOURCE_CHANGED' ? 'source_changed'
    : error?.code === 'USAGE_UTF8_INVALID' ? 'bad_row' : 'read_failed';
}

async function enumerate(root) {
  // usageFiles checks the optional legacy source using readFile; preflight its
  // size to reject already-oversized files before that existing enumeration.
  // A concurrent growth race inside usageFiles remains outside this bound.
  try { await sourceStat(path.join(root, '.usage.jsonl')); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  return usageFiles(root);
}

/**
 * @param {{root:string, objectKey:string, cursor?:string, limit?:number, now?:Date}} input
 */
export async function readAdoptionEvidence(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || typeof input.root !== 'string' || !input.root || input.root.includes('\0') || !path.isAbsolute(input.root)
    || typeof input.objectKey !== 'string') {
    return { status: 'error', reason: 'invalid_input', ...safety, rows: [] };
  }
  const key = canonicalObjectKey(input.objectKey);
  if (!key || key !== input.objectKey) return { status: 'error', reason: 'invalid_object_key', ...safety, rows: [] };
  const limit = Number.isSafeInteger(input.limit) && input.limit > 0 ? Math.min(input.limit, 100) : 50;
  let cursor;
  try { cursor = decodeCursor(input.cursor); } catch (error) {
    if (error.message === 'legacy_cursor') return { status: 'incomplete', reason: 'legacy_cursor', restartRequired: true, ...safety, rows: [] };
    return { status: 'error', reason: 'invalid_cursor', ...safety, rows: [] };
  }

  const root = path.resolve(input.root);
  const matches = [];
  let scanned = 0;
  let sources;
  const digest = createHash('sha256');
  digest.update(JSON.stringify(['adoption-evidence-v2', root, key]));
  try {
    sources = await enumerate(root);
  } catch (error) {
    return { status: 'incomplete', reason: sourceError(error), ...safety, rows: [] };
  }
  try {
    const before = [];
    for (const { file } of sources) before.push(await sourceStat(file));
    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex++) {
      const { file } = sources[sourceIndex];
      const sourceName = path.relative(root, file).split(path.sep).join('/');
      const text = await readUsageFile(sources[sourceIndex], { maxUncompressedBytes: MAX_BYTES });
      digest.update(JSON.stringify([sourceName, text]));
      let lineNumber = 0;
      // A truncated/malformed UTF-8 tail must make the whole query incomplete,
      // not leak replacement characters into a verdict note.
      if (text.includes('\ufffd')) return { status: 'incomplete', reason: 'bad_row', ...safety, rows: [] };
      for (let offset = 0; offset < text.length;) {
        const delimiter = text.indexOf('\n', offset);
        const end = delimiter === -1 ? text.length : delimiter;
        const line = text.slice(offset, end);
        offset = delimiter === -1 ? text.length : delimiter + 1;
        lineNumber++;
        if (++scanned > MAX_ROWS) return { status: 'incomplete', reason: 'too_many_rows', ...safety, rows: [] };
        if (!line) continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE) return { status: 'incomplete', reason: 'line_too_large', ...safety, rows: [] };
        const clean = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
        let row;
        try { row = JSON.parse(clean); } catch { return { status: 'incomplete', reason: 'bad_row', ...safety, rows: [] }; }
        if (!row || typeof row !== 'object' || Array.isArray(row)) return { status: 'incomplete', reason: 'bad_row', ...safety, rows: [] };
        if (row.kind !== 'positive' && row.kind !== 'correction') continue;
        if (canonicalObjectKey(row.objectKey ?? row.key ?? row.href) !== key) continue;
        if (Object.hasOwn(row, 'correlationId')
          && (typeof row.correlationId !== 'string' || !UUID_V4_RE.test(row.correlationId))) {
          return { status: 'incomplete', reason: 'bad_row', ...safety, rows: [] };
        }
        if (typeof row.t !== 'string' || !Number.isFinite(Date.parse(row.t))) {
          return { status: 'incomplete', reason: 'bad_row', ...safety, rows: [] };
        }
        const noteStatus = !Object.hasOwn(row, 'note') ? 'missing'
          : typeof row.note === 'string' && row.note.length <= 2048 && !/[\x00-\x1f\x7f]/.test(row.note)
            ? 'available' : 'unavailable';
        const note = noteStatus === 'available' ? row.note : '';
        const identity = createHash('sha256').update(JSON.stringify([sourceName, lineNumber, line])).digest('hex');
        matches.push({ t: row.t, k: row.kind, n: note, noteStatus, href: key, identity, sourceIndex, lineNumber,
          ...(Object.hasOwn(row, 'correlationId') ? { correlationId: row.correlationId } : {}) });
        if (matches.length > MAX_MATCHES) return { status: 'incomplete', reason: 'too_many_matches', ...safety, rows: [] };
      }
    }
    // Re-enumeration and path identity checks detect ordinary concurrent changes.
    // They cannot make separate files into an atomic snapshot or defeat ABA races.
    const afterSources = await enumerate(root);
    if (afterSources.length !== sources.length || sources.some((s, i) => s.file !== afterSources[i].file)) {
      return { status: 'incomplete', reason: 'source_changed', ...safety, rows: [] };
    }
    for (let i = 0; i < sources.length; i++) {
      if (!sameStat(before[i], await sourceStat(sources[i].file))) {
        return { status: 'incomplete', reason: 'source_changed', ...safety, rows: [] };
      }
    }
  } catch (error) {
    return { status: 'incomplete', reason: sourceError(error), ...safety, rows: [] };
  }

  const snapshotDigest = digest.digest('hex');
  matches.sort((a, b) => a.t.localeCompare(b.t) || a.k.localeCompare(b.k) || a.n.localeCompare(b.n)
    || a.href.localeCompare(b.href) || a.sourceIndex - b.sourceIndex || a.lineNumber - b.lineNumber);
  if (cursor && (cursor.d !== snapshotDigest || cursor.i >= matches.length || matches[cursor.i].identity !== cursor.r)) {
    return { status: 'incomplete', reason: 'cursor_not_found', restartRequired: true, ...safety, rows: [] };
  }
  const start = cursor ? cursor.i + 1 : 0;
  const page = matches.slice(start, start + limit);
  const rows = page.map((r) => ({ t: r.t, kind: r.k, note: r.n, noteStatus: r.noteStatus, href: r.href,
    provenance: 'caller/user-action', evidenceRef: `usage:${r.t}:${r.k}`,
    ...(r.correlationId === undefined ? {} : { correlationId: r.correlationId }) }));
  const nextCursor = start + limit < matches.length && page.length ? encodeCursor(snapshotDigest, page.at(-1), start + page.length - 1) : null;
  const result = { status: 'ok', objectKey: key, rows, nextCursor, scanned, hasMore: nextCursor !== null, ...safety };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE) {
    return { status: 'incomplete', reason: 'response_too_large', ...safety, rows: [], objectKey: key };
  }
  return result;
}
