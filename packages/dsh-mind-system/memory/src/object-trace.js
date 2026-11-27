/**
 * Read-only trace of one logical memory object across its lifecycle hops.
 *
 * Hops: write (physical ledger) -> index (MEMORY.md row) -> recall (usage
 * exposure) -> read (usage read) -> adoption (unverified verdict declarations).
 * Every hop reports present | missing | unknown | not_observed | not_applicable
 * with bounded evidence pointers. This module NEVER writes, appends usage, or
 * changes admission counts: querying an object must not become a use signal.
 *
 * Membership is cooperative-filesystem best effort, not a hostile-race
 * guarantee. Scan bound violations discard all matches; evidence samples are
 * independently bounded and can be truncated without making the scan incomplete.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { canonicalObjectKey } from './object-key.js';
import { usageFiles } from './usage.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINE = 64 * 1024;
const MAX_ROWS = 10000;
const MAX_MATCHES = 256;
const MAX_RESPONSE = 64 * 1024;
const MAX_SHARDS = 48;
const WRITE_LEDGER = '.write-ledger.jsonl';
const USAGE_LEDGER = '.usage.jsonl';

const hop = (status, evidence = []) => ({ status, evidence });
const finiteRow = (row) => row && typeof row === 'object' && !Array.isArray(row);
const boundedText = (v, max = 512) => typeof v === 'string' && v.length > 0 &&
  v.length <= max && Buffer.byteLength(v, 'utf8') <= max && !/[\x00-\x1f\x7f]/.test(v);

/** Bound one JSONL file; return matching rows or an incomplete marker. */
async function scanJsonl(file, visit, { required = false } = {}) {
  let handle;
  const out = { incomplete: false };
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) return { ...out, incomplete: true };
    const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
    let read = 0;
    while (read < buf.length) {
      const n = (await handle.read(buf, read, buf.length - read, read)).bytesRead;
      if (!n) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString('utf8');
    if (read < stat.size || text.includes('\ufffd')) return { ...out, incomplete: true };
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length > MAX_ROWS) return { ...out, incomplete: true };
    for (const line of lines) {
      if (!line || Buffer.byteLength(line, 'utf8') > MAX_LINE) return { ...out, incomplete: true };
      // Real shards carry a UTF-8 BOM on their first line; strip it per line so a
      // legitimate historical row is not mistaken for a corrupt tail.
      const clean = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
      let row;
      try { row = JSON.parse(clean); } catch { return { ...out, incomplete: true }; }
      if (!finiteRow(row)) return { ...out, incomplete: true };
      visit(row);
    }
    return out;
  } catch (err) {
    if (!required && (err?.code === 'ENOENT' || err?.code === 'ENOTDIR')) return out;
    return { ...out, incomplete: true };
  } finally { if (handle) await handle.close(); }
}

function evidenceOf(row, fields) {
  const out = {};
  for (const f of fields) {
    const value = row[f];
    if (Object.hasOwn(row, f) && ['string', 'number', 'boolean'].includes(typeof value) &&
        boundedText(String(value))) out[f] = value;
  }
  return out;
}

/**
 * Trace one object. Root is host-bound; objectKey is derived/validated by the
 * caller through canonicalObjectKey and must be canonical here too.
 */
export async function traceObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { status: 'error', reason: 'invalid_input', hops: {} };
  }
  const key = canonicalObjectKey(input.objectKey);
  if (!key || key !== input.objectKey) return { status: 'error', reason: 'invalid_object_key', hops: {} };
  if (typeof input.root !== 'string' || !input.root || input.root.includes('\0') || !path.isAbsolute(input.root)) {
    return { status: 'error', reason: 'invalid_input', hops: {} };
  }
  const root = path.resolve(input.root);
  const hops = {};
  let incomplete = false;
  const derive = (row) => canonicalObjectKey(row.objectKey ?? row.key ?? row.href);

  // write: physical ledger, matched by derived objectKey (new v2 rows) or key (legacy).
  const aggregate = () => ({ total: 0, evidence: [], evidenceTruncated: false });
  const add = (target, row, fields) => {
    target.total++;
    if (target.evidence.length < MAX_MATCHES) target.evidence.push(evidenceOf(row, fields));
    else target.evidenceTruncated = true;
  };
  const write = aggregate();
  const wr = await scanJsonl(path.join(root, WRITE_LEDGER), (row) => {
    if (derive(row) === key) add(write, row, ['t', 'key', 'hash', 'op', 'id', 'tool', 'request_id']);
  });
  if (wr.incomplete) { incomplete = true; hops.write = hop('unknown'); }
  else hops.write = { status: write.total ? 'present' : 'missing', ...write };

  // index: MEMORY.md must contain a link/name resolving to this object key.
  let memory;
  try { memory = await fs.readFile(path.join(root, 'MEMORY.md'), 'utf8'); } catch (err) {
    if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') { incomplete = true; hops.index = hop('unknown'); }
    else hops.index = hop('missing');
  }
  if (memory !== undefined && Buffer.byteLength(memory, 'utf8') <= MAX_BYTES) {
    const hit = memory.split('\n').some((line) => canonicalObjectKey((line.match(/\]\(([^)]+)\)/) ?? [])[1]) === key
      || canonicalObjectKey((line.match(/\[([^\]]+)\]/) ?? [])[1]) === key);
    hops.index = hit ? hop('present') : hop('missing');
  } else if (memory !== undefined) { incomplete = true; hops.index = hop('unknown'); }

  // usage: legacy + live shards + compacted archives, all enumerated through the
  // same safety rules (no symlinks, no ambiguous duplicate months, bounded count,
  // deterministic oldest-first order). An unsafe enumeration is NOT a reason to
  // return a partial trace: usageFiles() throws a typed error and we fail closed.
  let sources = [];
  try {
    sources = await usageFiles(root);
  } catch {
    incomplete = true;
  }
  const legacyFile = path.join(root, USAGE_LEDGER);
  if (sources.length > MAX_SHARDS) { incomplete = true; sources = []; }
  const usage = { recall: aggregate(), read: aggregate(), adoption: aggregate() };
  for (const { file } of sources) {
    // The legacy file is optional; an enumerated live/archive source that vanished
    // or changed between enumeration and open is genuinely unsafe.
    const r = await scanJsonl(file, (row) => {
      if (derive(row) !== key) return;
      const kind = row.kind === 'positive' || row.kind === 'correction' ? 'adoption' : row.kind;
      if (kind === 'recall' || kind === 'read' || kind === 'adoption') {
        add(usage[kind], row, ['t', 'kind', 'href', 'objectKey', 'note']);
      }
    }, { required: file !== legacyFile });
    if (r.incomplete) { incomplete = true; break; }
  }
  if (incomplete) {
    for (const name of ['recall', 'read', 'adoption']) hops[name] = hop('unknown');
  } else {
    hops.recall = { status: usage.recall.total ? 'present' : 'missing', ...usage.recall };
    hops.read = { status: usage.read.total ? 'present' : 'missing', ...usage.read };
    // A matching declaration is not authenticated user adoption or goal proof.
    hops.adoption = {
      status: usage.adoption.total ? 'present' : 'not_observed', ...usage.adoption,
      attestation: 'usage_signal_record',
      provenance: 'unverified_legacy_or_caller_declaration',
      userIdentity: 'unverified',
      goalProof: 'not_evaluated',
      principleAttribution: 'not_evaluated',
      governanceEligible: false,
    };
  }

  // Any incomplete source discards ALL matches: a partial trace must never look
  // like evidence that some hops were cleanly absent.
  const result = { status: incomplete ? 'incomplete' : 'ok', reason: incomplete ? 'scan_incomplete' : undefined,
    objectKey: key, hops: incomplete ? {} : hops,
    // Exposure/read/write/index never establish execution or adoption.
    execution: 'not_observed', absenceMeansNoWrites: false, absenceMeansNoAdoption: false };
  // Keep exact totals while trimming sampled evidence to the response byte budget.
  const sampled = ['write', 'recall', 'read', 'adoption'].map((name) => hops[name]).filter((h) => h?.total !== undefined);
  while (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESPONSE) {
    const largest = sampled.reduce((a, b) => b.evidence.length > (a?.evidence.length ?? 0) ? b : a, null);
    if (!largest) return { status: 'incomplete', reason: 'response_too_large', objectKey: key, hops: {} };
    largest.evidence.pop();
    largest.evidenceTruncated = true;
  }
  return result;
}
