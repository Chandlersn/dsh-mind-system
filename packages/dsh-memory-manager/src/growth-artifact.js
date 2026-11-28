import path from 'node:path';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';

const LIMIT = 4 * 1024 * 1024;
const contains = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a, b) => sameFile(a, b) && a.size === b.size
  && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

/**
 * Read bounded current bytes, checking pathname and descriptor identities before
 * and after reading. This is a race detector, not an atomic filesystem snapshot:
 * portable Node APIs cannot securely traverse parent directory handles or defeat
 * an adversarial parent-directory ABA swap. No authorship or success is proved.
 */
export async function inspectGrowthArtifact(target, { cwd, memoryRoot } = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('growth_workspace_unavailable');
  if (memoryRoot !== undefined && memoryRoot !== null
    && (typeof memoryRoot !== 'string' || !path.isAbsolute(memoryRoot))) throw new Error('growth_memory_scope_invalid');
  if (typeof target !== 'string' || !target.trim() || target.includes('\0')) throw new Error('growth_artifact_path_required');
  const roots = await Promise.all([cwd, memoryRoot].filter(Boolean).map(async input => {
    const resolved = await fs.realpath(input);
    const stat = await fs.lstat(resolved, { bigint: true });
    if (!stat.isDirectory()) throw new Error('growth_artifact_scope_not_directory');
    return { input, resolved, stat };
  }));
  const requested = path.resolve(cwd, target);
  const resolved = await fs.realpath(requested);
  const root = roots.find(candidate => contains(candidate.resolved, resolved));
  if (!root) throw new Error('growth_artifact_outside_scope');
  const initial = await fs.lstat(resolved, { bigint: true });
  if (!initial.isFile() || initial.size > BigInt(LIMIT)) throw new Error('growth_artifact_size_or_type');

  // O_NOFOLLOW protects the final component where supported; all platforms also
  // compare the opened descriptor with the checked path before reading bytes.
  const file = await fs.open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(LIMIT)) throw new Error('growth_artifact_size_or_type');
    if (!sameVersion(initial, before)) throw new Error('growth_artifact_path_changed');
    const checkBinding = async () => {
      if (await fs.realpath(requested) !== resolved || await fs.realpath(root.input) !== root.resolved) {
        throw new Error('growth_artifact_path_changed');
      }
      const currentRoot = await fs.lstat(root.resolved, { bigint: true });
      const current = await fs.lstat(resolved, { bigint: true });
      if (!currentRoot.isDirectory() || !sameFile(root.stat, currentRoot)
        || !current.isFile() || !sameVersion(before, current)) throw new Error('growth_artifact_path_changed');
    };
    await checkBinding();
    const buffer = Buffer.alloc(LIMIT + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    const after = await file.stat({ bigint: true });
    if (used > LIMIT || BigInt(used) !== before.size || !sameVersion(before, after)) {
      throw new Error('growth_artifact_changed_during_read');
    }
    await checkBinding();
    return { path: resolved, sha256: createHash('sha256').update(buffer.subarray(0, used)).digest('hex'), bytes: used };
  } finally { await file.close(); }
}

export { growthQuestionId } from './growth-identity.js';
