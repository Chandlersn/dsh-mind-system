import path from 'node:path';
import { realpath, lstat } from 'node:fs/promises';
import { tokensOf } from './recall.js';
import { scanSecrets } from './secrets.js';

const scopeNames = {
  functions: /\bfunctions\b|功能域|功能模块/iu,
  insights: /\binsights\b|创新思想|可迁移原则|原则层/iu,
  capabilities: /\bcapabilities\b|能力台账|工具台账/iu,
  dao: /\bdao\b|指导思想|公理层|道层/iu,
};
const zones = Object.keys(scopeNames);
const scopeName = Object.values(scopeNames).map(re => re.source).join('|');
const scopeList = new RegExp(`^(?:${scopeName})(?:\\s*(?:和|与|及|以及|、|and|&)\\s*(?:${scopeName}))*`, 'iu');
const restriction = /(?:(?:只|仅)(?:允许|能|需)?\s*(?:搜索|检索|查找|查询|查阅|查看|读取|使用|找|查|看|搜|读|用|在|从)|仅限于?|限定在|限于)\s*(?:在|从)?\s*/gu;
// A negative or partially understood source restriction must never broaden a search.
const negative = /(?:不要|不需要|不必|不用|无需|禁止|不可|不能|不得|别|不)\s*(?:(?:再|自动|主动|去|执行|进行|用|使用|调用|SAG)\s*)*(?:查|搜|找|读|看|检索|召回|补查|SAG|正文|原文|全文|记忆)|排除|除去|除了|除[^，。；\n]{1,80}外|以外|之外|不含|不包括|不包含|跳过|忽略|\b(?:exclude|except|without|skip|do not|don't)\b/iu;
const outsideMemory = /日记|每日记录|实验层|候选区|项目(?:文档|目录|文件|资料|仓库)|工作(?:区|目录)|代码库|仓库(?:文档|目录|文件)|草稿|\b(?:daily|skills|scratch|workspace|project docs)\b/iu;
const scopeBoundary = /^\s*(?:$|中|里|内|的|[，。；：]|搜索|检索|查找|查询|查|搜|看|读)/u;

function formalScopes(text) {
  if (negative.test(text) || outsideMemory.test(text)) return null;
  const limits = [...text.matchAll(restriction)];
  if (limits.length) {
    if (limits.length !== 1) return null;
    const [limit] = limits;
    const tail = text.slice(limit.index + limit[0].length);
    const list = scopeList.exec(tail)?.[0];
    if (!list || !scopeBoundary.test(tail.slice(list.length))) return null;
    const remainder = tail.slice(list.length).replace(/^\s*(?:中|里|内|的)?\s*(?:搜索|检索|查找|查询|查阅|查看|读取|查|搜|看|读)?\s*(?:关于)?/u, '');
    return { zones: zones.filter(zone => scopeNames[zone].test(list)), topic: `${text.slice(0, limit.index)} ${remainder}` };
  }
  const locations = [...text.matchAll(/(?:在|从)\s*([^，。；\n]{1,80}?)(?:中|里|内)\s*(?:搜索|检索|查找|查询|查阅|查看|读取|搜|查|看|找|读)/gu)];
  if (locations.length) {
    const source = locations[0][1].trim();
    if (locations.length !== 1 || scopeList.exec(source)?.[0] !== source) return null;
    return { zones: zones.filter(zone => scopeNames[zone].test(source)), topic: text.replace(locations[0][0], ' ') };
  }
  return { zones: zones.filter(zone => scopeNames[zone].test(text)), topic: text.replace(new RegExp(scopeName, 'giu'), ' ') };
}

const bodyIntent = /正文|原文|全文|搜遍|跨域|所有记忆|详细记录|\b(?:passages?|full[ -]text|across memories)\b/i;
const pastIntent = /以前|上次|曾经|先前|过去|历史记录|查.{0,5}记忆|回忆|\b(?:recall|previously|past memor(?:y|ies)|last time)\b/i;
const privateText = /bearer\s+|\b(?:sag_|sk-|ghp_|github_pat_)|-----BEGIN|(?:password|secret|token|api[_ -]?key|密码|密钥)\s*[:=]/i;
const privateInput = /```|https?:\/\/|[\w.+-]+@[\w.-]+|[a-z]:[\\/]|(?:^|[\s"'(])(?:~?\/|\.\.\/)|\\\\/i;

export function planSagRecall(text, matches) {
  if (typeof text !== 'string' || text.length > 2048 || privateInput.test(text) || privateText.test(text) || scanSecrets(text).length) return null;
  if (!bodyIntent.test(text) && (matches.length || !pastIntent.test(text))) return null;
  const explicit = formalScopes(text);
  if (!explicit) return null;
  const selected = new Set(explicit.zones.length ? explicit.zones : matches.map(row => row.href.split('/')[0]).filter(zone => zones.includes(zone)));
  if (matches.length && !selected.size) return null;
  const topic = explicit.topic.replace(new RegExp(`${bodyIntent.source}|${pastIntent.source}`, 'gi'), ' ');
  const terms = [...tokensOf(topic)].filter(term => term.length <= 32 && !/\d{4}/.test(term)).slice(0, 12);
  if (!terms.length) return null;
  return { query: terms.join(' '), terms, zones: selected.size ? [...selected] : zones };
}

function ordinaryPath(file) {
  if (process.platform !== 'win32') return file;
  if (/^\\\\\?\\[a-z]:\\/i.test(file)) return file.slice(4);
  if (/^\\\\\?\\unc\\/i.test(file)) return '\\\\' + file.slice(8);
  return file;
}

async function collect(plan, root, search, signal, timeoutMs, budget) {
  const base = ordinaryPath(await realpath(root));
  const dirs = (await Promise.all(plan.zones.map(async zone => {
    const dir = path.join(base, zone);
    try { return (await lstat(dir)).isDirectory() && !path.relative(dir, ordinaryPath(await realpath(dir))) ? dir : null; }
    catch { return null; }
  }))).filter(Boolean);
  if (!dirs.length || signal.aborted) return '';
  const exclude = dirs.includes(path.join(base, 'dao'))
    ? ['_candidates', '_rejected', '_deleted'].map(name => path.join(base, 'dao', name)) : [];
  const result = await search(plan.query, { paths: dirs, exclude, limit: 3, signal, timeoutMs, maxResponseBytes: 65536 });
  if (result?.ok !== true || !Array.isArray(result.results) || signal.aborted) return '';
  const seen = new Set();
  let block = '';
  for (const hit of result.results.slice(0, 3)) {
    if (signal.aborted || typeof hit?.path !== 'string' || hit.path.length > 4096 || typeof hit.content !== 'string' || hit.content.length > 65536) continue;
    const file = ordinaryPath(hit.path);
    const leaf = path.basename(file);
    if (!path.isAbsolute(file) || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N} _.()-]{0,150}\.md$/iu.test(leaf) || !dirs.some(dir => !path.relative(dir, path.dirname(file)))) continue;
    try {
      if (!(await lstat(file)).isFile() || path.relative(file, ordinaryPath(await realpath(file)))) continue;
    } catch { continue; }
    const href = path.relative(base, file).split(path.sep).join('/');
    if (seen.has(href) || privateText.test(leaf) || scanSecrets(leaf).length || privateText.test(hit.content) || scanSecrets(hit.content).length) continue;
    const excerpt = hit.content.slice(0, 650).replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
    if (!excerpt || !plan.terms.some(term => (href + ' ' + excerpt).toLowerCase().includes(term))) continue;
    const heading = block || '### SAG 正式记忆正文节选（检索证据，引用时核对来源）';
    const prefix = `${heading}\n- ${href} — `;
    const left = budget - Buffer.byteLength(prefix);
    if (left < 24) continue;
    let body = '', bytes = 0;
    for (const char of excerpt) {
      bytes += Buffer.byteLength(char);
      if (bytes > left) break;
      body += char;
    }
    block = prefix + body;
    seen.add(href);
  }
  return block;
}

export async function recallSagPassages(plan, { root, search, signal, deadline, budget, onSearchStart }) {
  const timeoutMs = Math.min(120, Math.floor(deadline - performance.now()) - 5);
  if (!plan || timeoutMs < 20 || budget < 160 || signal?.aborted) return '';
  const controller = new AbortController();
  let finishSearch, searchState = 'unknown';
  const dispatch = async (query, options) => {
    try { finishSearch = onSearchStart?.(); } catch { /* Observation is optional. */ }
    const result = await search(query, options);
    if (result?.ok === true && Array.isArray(result.results)) searchState = 'success';
    else if (result?.ok === false) searchState = result.reason === 'timeout' ? 'timeout' : 'failed';
    return result;
  };
  let cancel;
  const stopped = new Promise(resolve => { cancel = () => { controller.abort(); resolve(''); }; });
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(cancel, timeoutMs);
  const expires = performance.now() + timeoutMs;
  try {
    const text = await Promise.race([stopped, collect(plan, root, dispatch, controller.signal, timeoutMs, Math.min(2048, budget))]);
    return performance.now() < expires && !controller.signal.aborted ? text : '';
  } catch { searchState = 'failed'; return ''; }
  finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    const outcome = signal?.aborted ? 'cancelled' : controller.signal.aborted || performance.now() >= expires ? 'timeout' : searchState;
    try { finishSearch?.(outcome); } catch { /* Observation is optional. */ }
  }
}
