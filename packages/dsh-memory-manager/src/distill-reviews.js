import path from 'node:path';
import { redactSecrets } from './secrets.js';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, realpath, mkdir, open, link, unlink } from 'node:fs/promises';

const validVersion = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const address = (candidate, materialVersion) => createHash('sha256').update(JSON.stringify([candidate, materialVersion])).digest('hex') + '.json';
const validConclusion = s => typeof s === 'string' && s.trim().length > 0 && s.length <= 4000;
async function directory(root, create) {
  const base = await realpath(root);
  const dir = path.join(base, '.distill-reviews');
  if (create) await mkdir(dir).catch(e => { if (e.code !== 'EEXIST') throw e; });
  const st = await lstat(dir);
  if (!st.isDirectory() || await realpath(dir) !== dir) throw Error('审阅存储目录不可核实');
  return dir;
}
export async function readReceipt(root, candidate, version) {
  let dir;
  try { dir = await directory(root, false); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const file = path.join(dir, address(candidate, version));
  let st;
  try { st = await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!st.isFile() || st.size > 32768) throw Error('审阅回执无法核实');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let receipt;
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== st.dev || opened.ino !== st.ino) throw Error('审阅回执读取时变化');
    receipt = JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
  if (receipt?.schema !== 1 || receipt.candidate !== candidate || receipt.materialVersion !== version || !validConclusion(receipt.conclusion) || !Number.isFinite(Date.parse(receipt.reviewedAt))) throw Error('审阅回执格式异常');
  return receipt;
}

export async function reviewState(root, scan) {
  const entries = [...scan.due.map(row => ['due', 'area:' + row.area, row]), ...scan.orphan.map(row => ['orphan', 'orphan:' + row.topic, row])];
  const list = [], pending = { ...scan, due: [], orphan: [] };
  let complete = !(scan.skipped || scan.truncated || scan.readUnknown);
  let receiptUnknown = false;
  for (const [group, candidate, row] of entries) {
    let receipt;
    if (validVersion(row.materialVersion)) {
      try { receipt = await readReceipt(root, candidate, row.materialVersion); }
      catch { receiptUnknown = true; }
    }
    list.push({ candidate, materialVersion: row.materialVersion ?? '', sections: row.sections ?? [], receipt, group, row });
  }
  if (receiptUnknown) { complete = false; pending.skipped = [pending.skipped, '审阅回执读取失败，已保留候选提示'].filter(Boolean).join('；'); }
  for (const item of list) if (!complete || !item.receipt) pending[item.group].push(item.row);
  return { list, pending, complete };
}

export async function recordReview(root, candidate, materialVersion, conclusion, rescan) {
  if (!validVersion(materialVersion) || typeof candidate !== 'string' || !validConclusion(conclusion)) throw Error('需要候选标识、完整版本与 1–4000 字符的审阅结论');
  if (redactSecrets(conclusion).hits.length || redactSecrets(candidate).hits.length) throw Error('审阅内容含凭据，未写入；请移除凭据后重试');
  const state = await reviewState(root, await rescan());
  if (!state.complete) throw Error('扫描或回执不完整，暂不能提交审阅');
  if (!state.list.some(item => item.candidate === candidate && item.materialVersion === materialVersion)) throw Error('候选不存在或素材版本已变化，请重新列举');
  const dir = await directory(root, true);
  const file = path.join(dir, address(candidate, materialVersion));
  const tmp = path.join(dir, `${randomUUID()}.tmp`);
  const handle = await open(tmp, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(JSON.stringify({schema: 1, candidate, materialVersion, reviewedAt: new Date().toISOString(), conclusion}));
      await handle.sync();
    } finally { await handle.close(); }
    try { await link(tmp, file); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const receipt = await readReceipt(root, candidate, materialVersion);
    if (!receipt || receipt.conclusion !== conclusion) throw Error('该版本已有不同结论，请核对既有回执');
    return receipt;
  } finally { await unlink(tmp); }
}
