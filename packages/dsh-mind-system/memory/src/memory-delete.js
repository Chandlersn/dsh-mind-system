/**
 * Layer-aware deletion policy for distilled memory results.
 *
 * The human gate stays ONLY at 道 (L0 / dao/): the tool refuses it and points at
 * the existing panel confirmation path. 法/术/器 (L1 insights, L2 functions,
 * L3 capabilities) may self-delete, but always into a per-zone archive so the
 * content is recoverable. This module is pure policy: no IO, no authority, no
 * caller-declared layer is trusted — the zone is derived from a fixed map.
 */

const ZONE_LAYER = Object.freeze({
  dao: 'L0',
  insights: 'L1',
  functions: 'L2',
  capabilities: 'L3',
});

const ARCHIVE = Object.freeze({
  dao: 'dao/_deleted',
  insights: 'insights/_deleted',
  functions: 'functions/_deleted',
  capabilities: 'capabilities/_deleted',
});

/**
 * @param {{zone?:string, name?:string}} input
 * @returns {{ok:true, zone:string, layer:string, source:string, archive:string, slug:string}
 *          |{ok:false, code:string, message:string}}
 */
export function planMemoryDelete(input) {
  const zone = typeof input?.zone === 'string' ? input.zone.trim() : '';
  const layer = ZONE_LAYER[zone];
  if (!layer) return { ok: false, code: 'unsupported_zone',
    message: 'zone 必须是 functions / insights / capabilities / dao 之一。' };
  if (zone === 'dao') return { ok: false, code: 'human_gate_required',
    message: '道（L0）的删除只能在面板走人工确认（axiom-action / dao-action），工具层拒绝自治删除。' };
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (!name || !/^[^/\\:*?"<>|]+$/.test(name) || name.includes('..') || name.length > 120) {
    return { ok: false, code: 'invalid_name', message: 'name 必须是不含路径分隔符的条目 slug。' };
  }
  return { ok: true, zone, layer, slug: name,
    source: `${zone}/${name}.md`, archive: `${ARCHIVE[zone]}/${name}.md` };
}
