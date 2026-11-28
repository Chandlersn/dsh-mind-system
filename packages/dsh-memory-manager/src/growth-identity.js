import path from 'node:path';
import { createHash } from 'node:crypto';

// Native provider IDs are opaque and may contain composite separators such as |.
const ID_RE = /^[^\s\x00-\x1f\x7f]{1,512}$/;

/** Bind one question to the recorded cycle, checkpoint call and artifact bytes. */
export function growthQuestionId(cycleId, checkpointCallId, artifact) {
  if (typeof cycleId !== 'string' || !ID_RE.test(cycleId)
    || typeof checkpointCallId !== 'string' || !ID_RE.test(checkpointCallId)
    || !artifact || typeof artifact.path !== 'string' || !(path.win32.isAbsolute(artifact.path) || path.posix.isAbsolute(artifact.path))
    || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 0 || artifact.bytes > 4 * 1024 * 1024) {
    throw new Error('growth_question_identity_invalid');
  }
  return `growth:${createHash('sha256').update(JSON.stringify([cycleId, checkpointCallId, artifact.path, artifact.sha256, artifact.bytes])).digest('hex')}`;
}
