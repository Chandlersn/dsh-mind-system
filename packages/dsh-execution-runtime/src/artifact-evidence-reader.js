import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const ARTIFACT_EVIDENCE_LIMITS = Object.freeze({ refs: 32, fileBytes: 8 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024, chunkBytes: 64 * 1024, outputBytes: 64 * 1024, refChars: 32768 });
const result = (status, reason, refs = [], bytesRead = 0) => ({ status, reason, refs, bytesRead,
  goalProof: 'not_evaluated', principleAttribution: 'not_evaluated', governanceEligible: false });
const fail = (reason, status = 'unknown') => { throw Object.assign(new Error(reason), { evidenceStatus: status }); };
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
const same = (a, b) => ['dev', 'ino', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', 'birthtimeNs']
  .every((key) => a[key] === b[key]);
const nativeAbsolute = (value) => typeof value === 'string' && value.length > 0
  && value.length <= ARTIFACT_EVIDENCE_LIMITS.refChars && !value.includes('\0') && path.isAbsolute(value)
  && (process.platform === 'win32' ? (/^(?:[a-z]:[\\/]|\\\\[^\\?.])/i.test(value)
    && !value.slice(2).includes(':')) : !value.startsWith('//'));

// Walk from the volume root, including ancestors of the trusted workspace. Node exposes
// symlinks and Windows junctions through lstat; arbitrary reparse types are not portable.
function checkedPath(target) {
  const parsed = path.parse(target);
  let current = parsed.root;
  let stat = fs.lstatSync(current, { bigint: true });
  if (stat.isSymbolicLink()) fail('link_not_allowed');
  const segments = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    if (!stat.isDirectory()) fail('ancestor_not_directory');
    current = path.join(current, segments[index]);
    stat = fs.lstatSync(current, { bigint: true });
    if (stat.isSymbolicLink()) fail('link_not_allowed');
  }
  return stat;
}
function checkedFile(root, realRoot, target) {
  if (!inside(root, target)) fail('outside_workspace');
  const stat = checkedPath(target);
  if (!stat.isFile()) fail('not_regular_file');
  if (stat.nlink > 1n) fail('hardlink_not_allowed');
  if (!inside(realRoot, fs.realpathSync(target))) fail('realpath_outside_workspace');
  if (stat.size > BigInt(ARTIFACT_EVIDENCE_LIMITS.fileBytes)) fail('file_byte_limit');
  return stat;
}
function errorResult(index, error) {
  const reason = error.evidenceStatus ? error.message
    : ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'file_missing'
      : ['EACCES', 'EPERM'].includes(error.code) ? 'access_denied' : 'filesystem_error';
  return { index, status: error.evidenceStatus || (reason === 'file_missing' ? 'unknown' : 'error'), reason };
}

/**
 * Synchronously compare native file:<absolute path>#sha256:<hex> references.
 * workspaceRoot is a TRUSTED HOST input, never an event/request-selected authority.
 * No URL decoding occurs. Unknown formats never establish a match. Only byte identity
 * is checked: neither goal achievement nor principle attribution is evaluated.
 *
 * Cooperative filesystem guarantee only: portable Node cannot atomically pin parent
 * directories or reject every Windows reparse type. Hostile ancestor replacement and
 * metadata restoration can evade these checks. nlink > 1 rejects observed hardlinks,
 * but cannot prove absence of transient aliases or aliases hidden by a filesystem.
 * Stronger guarantees require a host immutable snapshot or platform-specific opening.
 * Reads have fixed budgets even during growth; no contents, paths, or raw errors escape.
 */
export function readArtifactEvidence({ workspaceRoot, evidenceRefs } = {}) {
  if (!nativeAbsolute(workspaceRoot)) return result('error', 'invalid_workspace_root');
  if (!Array.isArray(evidenceRefs)) return result('unknown', 'invalid_evidence_refs');
  if (!evidenceRefs.length) return result('unknown', 'empty_evidence_refs');
  if (evidenceRefs.length > ARTIFACT_EVIDENCE_LIMITS.refs) return result('unknown', 'reference_count_limit');
  let root, realRoot, rootStat;
  try {
    root = path.resolve(workspaceRoot);
    rootStat = checkedPath(root);
    if (!rootStat.isDirectory()) fail('workspace_not_directory', 'error');
    realRoot = fs.realpathSync(root);
  } catch (error) {
    const entry = errorResult(0, error);
    return result(entry.status, entry.reason);
  }
  const refs = [];
  const prepared = [];
  let reserved = 0;
  // Preflight every reference before opening any file for content reads.
  for (let index = 0; index < evidenceRefs.length; index++) {
    try {
      const ref = evidenceRefs[index];
      if (typeof ref !== 'string') fail('invalid_reference');
      if (ref.length > ARTIFACT_EVIDENCE_LIMITS.refChars) fail('reference_length_limit');
      const marker = ref.lastIndexOf('#sha256:');
      if (!ref.startsWith('file:') || marker < 5 || !/^[a-f0-9]{64}$/i.test(ref.slice(marker + 8))) fail('unsupported_reference');
      const rawPath = ref.slice(5, marker);
      if (!nativeAbsolute(rawPath)) fail('non_native_absolute_path');
      const target = path.resolve(rawPath);
      const stat = checkedFile(root, realRoot, target);
      const size = Number(stat.size);
      if (reserved + size > ARTIFACT_EVIDENCE_LIMITS.totalBytes) fail('total_byte_limit');
      reserved += size;
      prepared.push({ index, target, stat, expectedSha256: ref.slice(marker + 8).toLowerCase() });
      refs[index] = { index, status: 'unknown', reason: 'not_read' };
    } catch (error) { refs[index] = errorResult(index, error); }
  }
  let bytesRead = 0;
  const buffer = Buffer.alloc(ARTIFACT_EVIDENCE_LIMITS.chunkBytes);
  for (const item of prepared) {
    let fd;
    let fileBytes = 0;
    try {
      const before = checkedFile(root, realRoot, item.target);
      if (!same(item.stat, before)) fail('file_changed');
      fd = fs.openSync(item.target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.nlink > 1n || !same(before, opened)) fail('file_changed');
      const hash = createHash('sha256');
      const size = Number(opened.size);
      while (fileBytes < size) {
        const length = Math.min(buffer.length, size - fileBytes, ARTIFACT_EVIDENCE_LIMITS.totalBytes - bytesRead);
        if (length <= 0) fail('total_byte_limit');
        const count = fs.readSync(fd, buffer, 0, length, fileBytes);
        if (count === 0) fail('file_changed');
        fileBytes += count;
        bytesRead += count;
        hash.update(buffer.subarray(0, count));
      }
      if (!same(opened, fs.fstatSync(fd, { bigint: true }))) fail('file_changed');
      const after = checkedFile(root, realRoot, item.target);
      if (!same(opened, after) || !same(rootStat, checkedPath(root)) || fs.realpathSync(root) !== realRoot) fail('file_changed');
      const actualSha256 = hash.digest('hex');
      const matches = actualSha256 === item.expectedSha256;
      refs[item.index] = { index: item.index, status: matches ? 'match' : 'mismatch',
        reason: matches ? 'sha256_match' : 'sha256_mismatch', expectedSha256: item.expectedSha256, actualSha256, bytesRead: fileBytes };
    } catch (error) { refs[item.index] = { ...errorResult(item.index, error), bytesRead: fileBytes }; }
    finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { refs[item.index] = { index: item.index, status: 'error', reason: 'close_failed', bytesRead: fileBytes }; } } }
  }
  const status = ['error', 'unknown', 'mismatch'].find((value) => refs.some((entry) => entry.status === value)) || 'match';
  const output = result(status, status === 'match' ? 'all_artifacts_match' : 'artifacts_not_verified', refs, bytesRead);
  // Defense in depth: fields above are fixed-size and at most 32 entries are returned.
  return Buffer.byteLength(JSON.stringify(output)) <= ARTIFACT_EVIDENCE_LIMITS.outputBytes
    ? output : result('error', 'output_byte_limit');
}
