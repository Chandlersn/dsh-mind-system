/**
 * Canonical logical-object identity for a memory object.
 *
 * Write ledgers, write_context targets, usage entries and recall rows each carry
 * an identity string that means "which memory object is this about". Those
 * strings are produced in different places with slightly different spellings
 * (backslash vs slash, with/without .md, file:// URLs for skills). This module
 * is the ONE pure function that folds all of them to a stable POSIX-relative
 * object key, or `undefined` when the identity cannot be established.
 *
 * NEVER accept a caller-declared objectKey as authoritative: derive it from an
 * already-validated target/key/href. Derive failure => unknown, never a write
 * rejection and never an invented identity. No IO, no state, no throwing on
 * ordinary unknown input.
 */
import { FILE_ZONES } from './constants.js';

// Only file-backed zones with <zone>/<slug>.md identity. `daily` is handled
// separately (top-level YYYY-MM-DD.md / daily/YYYY-MM.md archives).
const ZONE_DIR = new Set(FILE_ZONES);

/** Normalize separators and drop harmless ./ and trailing slash forms (no path traversal). */
function normalize(value) {
  let s = String(value ?? '').trim();
  if (!s) return undefined;
  s = s.replaceAll('\\', '/');
  if (/^[a-zA-Z]:/.test(s) || s.startsWith('/') || s.includes('\0')) return undefined;
  // A file:// URL is only meaningful for the host skill bundle; parse it, do not
  // treat arbitrary URLs as relative paths.
  if (/^file:\/\//i.test(s)) {
    try {
      const url = new URL(s);
      const segs = decodeURIComponent(url.pathname).split('/').filter(Boolean);
      const at = segs.lastIndexOf('skills');
      if (at >= 0 && segs[at + 2] === 'SKILL.md') s = `skills/${segs[at + 1]}/SKILL.md`;
      else return undefined;
    } catch { return undefined; }
  }
  if (s.split('/').some((part) => part === '..')) return undefined;
  const parts = [];
  for (const part of s.split('/')) {
    if (!part || part === '.') continue;
    let safe = part;
    // Decode only a whole path segment, never a mangled half-escaped string.
    if (safe.includes('%')) {
      try { safe = decodeURIComponent(safe); } catch { return undefined; }
    }
    parts.push(safe);
  }
  return parts.length ? parts.join('/') : undefined;
}

function isSlug(part) {
  if (!part || part.length > 60 || part !== part.trim()) return false;
  if (/[\\/:*?"<>|\0]/.test(part) || part.includes('..') || part.startsWith('.')) return false;
  if (/^memory$/i.test(part) || /^\d{4}-\d{2}-\d{2}$/.test(part)) return false;
  return true;
}

/**
 * Return the canonical object key, or `undefined` when unknown.
 * Accepts: MEMORY.md, functions|insights|dao|capabilities/<slug>.md,
 * dao/_candidates/<slug>.md, skills/<name>/SKILL.md, top-level YYYY-MM-DD.md,
 * daily/YYYY-MM.md. Case is preserved (Windows paths are not case-folded).
 */
export function canonicalObjectKey(input) {
  const s = normalize(input);
  if (!s) return undefined;
  if (s === 'MEMORY.md') return 'MEMORY.md';
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(s)) return s;
  if (/^daily\/\d{4}-\d{2}\.md$/.test(s)) return s;
  const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(s);
  if (skill) return isSlug(skill[1]) ? `skills/${skill[1]}/SKILL.md` : undefined;
  const parts = s.split('/');
  if (!ZONE_DIR.has(parts[0])) return undefined;
  const withMd = s.endsWith('.md') ? s : `${s}.md`;
  const final = withMd.split('/');
  if (final[0] === 'dao' && final[1] === '_candidates') {
    return final.length === 3 && isSlug(final[2].replace(/\.md$/, '')) ? `dao/_candidates/${final[2]}` : undefined;
  }
  if (final.length !== 2 || !final[1].endsWith('.md')) return undefined;
  const slug = final[1].replace(/\.md$/, '');
  return isSlug(slug) ? `${final[0]}/${slug}.md` : undefined;
}
