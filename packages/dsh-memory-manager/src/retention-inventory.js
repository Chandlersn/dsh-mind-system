import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { AUTO_DAILY_ARCHIVE_ENABLED } from './daily-archive.js';

const MAX_ENTRIES = 10000;
const DEFAULT_ENTRIES = 1000;
const MONTH = /^\d{4}-\d{2}\.jsonl$/;

/**
 * Read bounded metadata from fixed locations below explicit roots.
 * Counts are observed lower bounds whenever unknown is true. This is a
 * non-atomic snapshot, not evidence of ownership or permission to clean up.
 * Roots must be controlled by the caller. Concurrent path replacement can race
 * path-based checks; Node does not offer a portable directory-relative no-follow API.
 */
export async function retentionInventory({ memoryRoot, storageRoot, maxEntries = DEFAULT_ENTRIES } = {}) {
  if (typeof memoryRoot !== 'string' || !path.isAbsolute(memoryRoot) ||
      typeof storageRoot !== 'string' || !path.isAbsolute(storageRoot)) {
    throw new TypeError('Explicit absolute memoryRoot and storageRoot are required');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) {
    throw new RangeError('maxEntries must be an integer between 1 and 10000');
  }

  const categories = {};
  const specs = [
    ['usage_shards', memoryRoot, ['.usage'], 'directory', MONTH],
    ['usage_archive', memoryRoot, ['.usage', 'archive'], 'directory', MONTH],
    ['usage_legacy', memoryRoot, ['.usage.jsonl'], 'file'],
    ['write_ledger', memoryRoot, ['.write-ledger.jsonl'], 'file'],
    ['stage', memoryRoot, ['.stage'], 'directory', null],
    ['valves_decisions', storageRoot, ['mind-valves.jsonl'], 'file'],
    ['clis_history', storageRoot, ['clis-history.json'], 'file'],
    ['clis_interventions', storageRoot, ['clis-interventions.jsonl'], 'file'],
  ];

  for (const [category, root, parts, kind, pattern] of specs) {
    const result = { files: 0, bytes: 0, unknown: false, risks: [] };
    categories[category] = result;
    // Source behavior: compactUsage and sweepStaleStages are currently disabled.
    if (category === 'usage_shards') result.risks.push('automatic_compaction_disabled');
    if (category === 'stage') result.risks.push('automatic_orphan_cleanup_disabled');
    const risk = (code) => {
      result.unknown = true;
      if (!result.risks.includes(code)) result.risks.push(code);
    };
    const inspect = async (file, missingAllowed) => {
      try { return await lstat(file); }
      catch (error) {
        if (error?.code === 'ENOENT' && missingAllowed) {
          if (!result.risks.includes('missing')) result.risks.push('missing');
        } else risk('unavailable');
        return null;
      }
    };
    let current = path.normalize(root);
    let st;
    try { st = await lstat(current); }
    catch (error) {
      risk(error?.code === 'ENOENT' ? 'root_missing' : 'unavailable');
      continue;
    }
    if (st.isSymbolicLink()) { risk('symlink'); continue; }
    if (!st.isDirectory()) { risk('unexpected_type'); continue; }
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      st = await inspect(current, true);
      if (!st) break;
      if (st.isSymbolicLink()) { risk('symlink'); st = null; break; }
      if (i < parts.length - 1 && !st.isDirectory()) {
        risk('unexpected_type'); st = null; break;
      }
    }
    if (!st) continue;
    const countFile = (entry) => {
      if (!entry.isFile()) { risk('unexpected_type'); return; }
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 ||
          !Number.isSafeInteger(result.bytes + entry.size)) { risk('size_overflow'); return; }
      result.files++;
      result.bytes += entry.size;
    };
    if (kind === 'file') { countFile(st); continue; }
    if (!st.isDirectory()) { risk('unexpected_type'); continue; }
    let dir;
    try {
      dir = await opendir(current, { bufferSize: 32 });
      let seen = 0;
      while (true) {
        const entry = await dir.read();
        if (!entry) break;
        if (seen++ >= maxEntries) { risk('limit_reached'); break; }
        if (pattern && !pattern.test(entry.name)) continue;
        const entryStat = await inspect(path.join(current, entry.name), false);
        if (!entryStat) continue;
        if (entryStat.isSymbolicLink()) { risk('symlink'); continue; }
        countFile(entryStat);
      }
    } catch {
      risk('unavailable');
    } finally {
      if (dir) {
        try { await dir.close(); } catch { risk('unavailable'); }
      }
    }
  }
  // A paused scheduler does not establish that cleanup has completed.
  const risks = ['non_atomic_snapshot', 'no_cleanup_authority'];
  if (!AUTO_DAILY_ARCHIVE_ENABLED) risks.push('automatic_daily_archive_paused');
  return { categories, risks };
}
