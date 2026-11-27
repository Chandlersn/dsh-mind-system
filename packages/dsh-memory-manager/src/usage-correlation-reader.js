import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { canonicalObjectKey } from './object-key.js';
import { redactSecrets } from './secrets.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_FILES = 64, MAX_ENTRIES = 256, MAX_BYTES = 8 * 1024 * 1024, MAX_ROWS = 100000, MAX_LINE = 65536;
const fail = reason => { throw new Error(reason); };
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key =>
  typeof a[key] === 'bigint' && typeof b[key] === 'bigint' && a[key] === b[key]);

async function maybeStat(file) {
  try { return await fs.lstat(file, { bigint: true }); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function enumerate(root) {
  const rootStat = await fs.lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('unsafe_source');
  const files = [], states = [];
  const legacy = path.join(root, '.usage.jsonl');
  const legacyStat = await maybeStat(legacy);
  if (legacyStat) {
    if (!legacyStat.isFile() || legacyStat.isSymbolicLink()) fail('unsafe_source');
    files.push({ file: legacy, stat: legacyStat, source: 'legacy' });
  }
  states.push(legacyStat ? 'present' : 'absent');
  const months = [new Set(), new Set()];
  for (const [index, dir] of [path.join(root, '.usage'), path.join(root, '.usage', 'archive')].entries()) {
    const info = await maybeStat(dir);
    if (!info) { states.push('absent'); continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_source');
    states.push('present');
    const handle = await fs.opendir(dir);
    let seen = 0;
    for await (const entry of handle) {
      if (++seen > MAX_ENTRIES) fail('enumeration_limit');
      if (!/^\d{4}-\d{2}\.jsonl$/.test(entry.name)) continue;
      if (files.length >= MAX_FILES) fail('file_limit');
      const file = path.join(dir, entry.name), stat = await fs.lstat(file, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) fail('unsafe_source');
      months[index].add(entry.name);
      files.push({ file, stat, source: index ? 'archive' : 'live' });
    }
  }
  if ([...months[0]].some(name => months[1].has(name))) fail('ambiguous_sources');
  files.sort((a, b) => a.file.localeCompare(b.file));
  return { files, states, rootStat };
}
function validRow(row) {
  const keyInput = row.objectKey ?? row.key ?? row.href;
  if (typeof keyInput !== 'string' || keyInput.length > 4096) return null;
  const objectKey = canonicalObjectKey(keyInput);
  if (!objectKey || objectKey.length > 512 || redactSecrets(objectKey).text !== objectKey || /[\x00-\x1f\x7f]/.test(objectKey)) return null;
  for (const field of ['objectKey', 'key', 'href']) {
    if (row[field] !== undefined && (typeof row[field] !== 'string' || canonicalObjectKey(row[field]) !== objectKey)) return null;
  }
  if (!['positive', 'correction'].includes(row.kind) || typeof row.t !== 'string' || !Number.isFinite(Date.parse(row.t)) ||
      (row.n !== undefined && row.n !== 1) || (row.note !== undefined && (typeof row.note !== 'string' || row.note.length > 2048 || /[\x00-\x1f\x7f]/.test(row.note)))) return null;
  const note = row.note ?? '';
  if (redactSecrets(note).text !== note) return null;
  return { objectKey, kind: row.kind, note, noteStatus: row.note === undefined ? 'missing_normalized_empty' : 'available' };
}

/** Internal comparison data only; do not expose rows as tool output. */
export async function readUsageCorrelation(root, correlationId) {
  const base = { scope: 'unknown', snapshot: 'unknown', rows: [], duplicate: false, overflow: false };
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0') || typeof correlationId !== 'string' || !UUID.test(correlationId)) return { ...base, status: 'error', reason: 'invalid_input' };
  let files, matches = [], bytes = 0, rows = 0;
  try {
    const first = await enumerate(root); files = first.files;
    for (const item of files) {
      const handle = await fs.open(item.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || !same(before, item.stat)) fail('source_changed');
        if (before.size < 0n || before.size > BigInt(MAX_BYTES - bytes)) fail('byte_limit');
        const size = Number(before.size);
        const buffer = Buffer.alloc(size + 1);
        let count = 0;
        while (count < buffer.length) {
          const read = await handle.read(buffer, count, buffer.length - count, count);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true }), pathAfter = await fs.lstat(item.file, { bigint: true });
        if (pathAfter.isSymbolicLink() || !same(before, after) || !same(before, pathAfter) || count !== size) fail('source_changed');
        bytes += count;
        let start = 0;
        while (start < count) {
          if (++rows > MAX_ROWS) fail('row_limit');
          const end = buffer.indexOf(10, start);
          if (end < 0 || end >= count) fail('truncated_tail');
          if (end - start > MAX_LINE) fail('line_limit');
          let text;
          try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(start, end)); } catch { fail('invalid_utf8'); }
          start = end + 1;
          if (!text.trim()) continue;
          let row;
          try { row = JSON.parse(text); } catch { fail('invalid_json'); }
          if (!row || typeof row !== 'object' || Array.isArray(row)) fail('invalid_json');
          if (row.correlationId === correlationId) {
            const valid = validRow(row);
            if (!valid) fail('invalid_matching_row');
            if (matches.length < 3) matches.push(valid);
          }
        }
      } finally { await handle.close(); }
    }
    const last = await enumerate(root);
    if (!same(first.rootStat, last.rootStat) || JSON.stringify(first.states) !== JSON.stringify(last.states) || files.length !== last.files.length || files.some((f, i) => f.file !== last.files[i].file || !same(f.stat, last.files[i].stat))) fail('source_changed');
    return { ...base, status: matches.length ? 'observed' : 'not_observed', scope: 'selected_sources_complete', sourceState: files.length ? 'present' : 'absent', rows: matches.slice(0, 2), duplicate: matches.length > 1, overflow: matches.length > 2 };
  } catch (error) {
    const known = new Set(['unsafe_source', 'enumeration_limit', 'file_limit', 'ambiguous_sources', 'source_changed', 'byte_limit', 'row_limit', 'truncated_tail', 'line_limit', 'invalid_utf8', 'invalid_json', 'invalid_matching_row']);
    return { ...base, status: 'incomplete', reason: known.has(error?.message) ? error.message : 'source_unavailable' };
  }
}
