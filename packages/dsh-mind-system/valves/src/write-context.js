// Admission identity is a bounded bridge assertion, never proof of execution or adoption.
const fields = ['schema_version', 'source', 'event', 'mode', 'tool', 'tool_action', 'target', 'origin_basis', 'execution_result', 'adoption'];
const mappings = {
 memory_write: { write: ['function', 'functions/'] },
 memory_insight: { write: ['insight', 'insights/'] },
 memory_dao: { active: ['dao', 'dao/'], candidate: ['dao_candidate', 'dao/_candidates/'] },
 memory_capability: { record: ['capability', 'capabilities/'] },
 memory_index: { upsert: ['index_entry', 'functions/', 'insights/'] },
};
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
 && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function normalizeWriteContext(value) {
 try {
  const version = value?.schema_version;
  if (![1, 2].includes(version) || !exact(value, version === 2 ? [...fields, 'request_id'] : fields)
   || (version === 2 && (typeof value.request_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.request_id)))
   || value.source !== 'dsh-memory-manager'
   || value.event !== 'write_admission' || value.mode !== 'observational' || value.origin_basis !== 'bridge_default'
   || value.execution_result !== 'not_observed' || value.adoption !== 'not_observed'
   || !Object.hasOwn(mappings, value.tool) || !Object.hasOwn(mappings[value.tool], value.tool_action)) return undefined;
  const [kind, ...prefixes] = mappings[value.tool][value.tool_action];
  let target = null;
  if (value.target !== null) {
   if (!exact(value.target, ['kind', 'key']) || value.target.kind !== kind || typeof value.target.key !== 'string'
    || Buffer.byteLength(value.target.key) > 1024 || /[\u0000-\u001f\u007f]/.test(value.target.key)) return undefined;
   const key = value.target.key;
   const prefix = prefixes.find(p => key.startsWith(p));
   if (!prefix || !/^[^/\\]+\.md$/.test(key.slice(prefix.length))) return undefined;
   target = { kind, key };
  }
  return { schema_version: version, ...(version === 2 ? { request_id: value.request_id } : {}), source: 'dsh-memory-manager', event: 'write_admission', mode: 'observational',
   tool: value.tool, tool_action: value.tool_action, target, origin_basis: 'bridge_default',
   execution_result: 'not_observed', adoption: 'not_observed' };
 } catch { return undefined; }
}
