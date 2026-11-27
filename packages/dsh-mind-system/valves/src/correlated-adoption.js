// Keep credential patterns aligned with memory-manager's tier-one redaction.
const secrets = [
  ['openai-key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36}\b/g],
  ['github-fine-grained', /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['aws-key', /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g],
  ['gcloud-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['stripe-key', /\b[rs]k_live_[A-Za-z0-9]{20,}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['hf-token', /\bhf_[A-Za-z0-9]{34,}\b/g],
  ['telegram-bot', /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['private-key-block', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['credential-assignment', /(?:api[_-]?key|secret|token|passwd|password|private[_-]?token)\s*[:=]\s*(?:"[A-Za-z0-9+/_=-]{16,}"|'[A-Za-z0-9+/_=-]{16,}'|[A-Za-z0-9+/_=-]{16,})/gi],
];

function redact(value) {
  for (const [kind, pattern] of secrets) value = value.replace(pattern, `[REDACTED:${kind}]`);
  return value;
}

function slug(value) {
  return value && value.length <= 60 && value === value.trim() && !/[\\/:*?"<>|\x00-\x1f\x7f%]/.test(value)
    && !value.includes('..') && !value.startsWith('.') && !/^memory$/i.test(value) && !/^\d{4}-\d{2}-\d{2}$/.test(value);
}

function canonicalKey(value) {
  if (typeof value !== 'string' || value.length > 256 || !value.isWellFormed() || redact(value) !== value) return false;
  if (value === 'MEMORY.md' || /^\d{4}-\d{2}-\d{2}\.md$/.test(value) || /^daily\/\d{4}-\d{2}\.md$/.test(value)) return true;
  const skill = /^skills\/([^/]+)\/SKILL\.md$/.exec(value);
  if (skill) return !!slug(skill[1]);
  const file = /^(?:functions|insights|dao|capabilities)\/(?:_candidates\/)?([^/]+)\.md$/.exec(value);
  if (!file || (value.includes('/_candidates/') && !value.startsWith('dao/_candidates/'))) return false;
  return !!slug(file[1]);
}

export function validateCorrelatedAdoption(input) {
  try {
    if (!input || typeof input !== 'object' || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const keys = Reflect.ownKeys(input);
    if (keys.some(key => typeof key !== 'string' || !['schemaVersion', 'eventId', 'objectKey', 'kind', 'note'].includes(key))) return null;
    if (!['schemaVersion', 'eventId', 'objectKey', 'kind'].every(key => Object.hasOwn(input, key))) return null;
    if (keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(input, key), 'value'))) return null;
    if (input.schemaVersion !== 1 || typeof input.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.eventId)) return null;
    if (!canonicalKey(input.objectKey) || !['positive', 'correction'].includes(input.kind)) return null;
    if (Object.hasOwn(input, 'note') && (typeof input.note !== 'string' || input.note.length > 2048 || !input.note.isWellFormed() || /[\x00-\x1f\x7f]/.test(input.note))) return null;
    return { eventId: input.eventId, objectKey: input.objectKey, kind: input.kind, note: redact(input.note ?? '').slice(0, 2048) };
  } catch { return null; }
}
