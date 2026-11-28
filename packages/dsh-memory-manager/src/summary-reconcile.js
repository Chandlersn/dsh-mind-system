import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { canonicalIssueIdentity, stableIssueFingerprint } from '../health-inbox.js';
import { withMemoryRootTransaction } from './root-transaction.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const normalize = p => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
const safeSubject = /^functions\/([\p{L}\p{M}\p{N}_ -]+)\.md$/u;

function validDate(s) {
  const date = new Date(`${s}T00:00:00Z`);
  return !!s && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
}

// Accept only an unambiguous subset of the writer's actual Markdown format.
export function summaryDates(text) {
  let head, newest, fence, headBody = false, inHead = false;
  if (text.includes('\0') || text.includes('\ufffd')) throw Error('无法解码正文');
  if (!/^# [^\r\n]+\r?\n/.test(text)) throw Error('无法确定功能文件标题及头部范围');
  for (const line of text.split(/\r?\n/)) {
    if (/<!--|-->/.test(line)) {
      if (/^\s*<!--[^<>]*-->\s*$/.test(line)) continue;
      throw Error('无法确认注释范围');
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker && !fence) { fence = marker[1]; continue; }
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (/^\s*<\/?[a-z!?]/i.test(line) || /^ {1,3}##\s*(?:\[|当前状态摘要)/.test(line) || /^##\s*$/.test(line)) throw Error('存在无法消歧的标题或 HTML 区块');
    if (/^#{1,2}\s/.test(line)) inHead = false;
    if (/^##\s*当前状态摘要/.test(line)) {
      const date = /^## 当前状态摘要（截至\s*(\d{4}-\d{2}-\d{2})）\s*$/.exec(line)?.[1];
      if (head || newest || !validDate(date)) throw Error('头部日期缺失或不明确');
      head = date; inHead = true;
    } else if (/^##\s*\[/.test(line)) {
      const date = /^## \[(\d{4}-\d{2}-\d{2})(?:补\d*)?\]\s+\S/.exec(line)?.[1];
      if (!validDate(date) || (newest && date < newest)) throw Error('迭代块日期无效或顺序不明确');
      newest = date;
    } else if (inHead && line.trim() && line.trim() !== '---') headBody = true;
  }
  if (!head || !headBody || !newest || fence) throw Error('头部、迭代块或代码围栏不完整');
  return { head, newest };
}

function version(st) { return [st.dev, st.ino, st.mode, st.nlink, st.size, st.ctimeNs, st.mtimeNs].join(':'); }

async function observe(root, scope, subject) {
  const file = path.join(root, subject);
  const dir = path.join(root, 'functions');
  if (normalize(await realpath(root)) !== scope || normalize(root) !== scope ||
      !(await lstat(root)).isDirectory() || !(await lstat(dir)).isDirectory() ||
      normalize(await realpath(file)) !== normalize(file)) throw Error('路径包含链接或范围已变化');
  const st = await lstat(file, { bigint: true });
  if (!st.isFile() || st.nlink !== 1n || st.ino === 0n || st.size > 1024n * 1024n) throw Error('无法验证单一受管常规文件');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    if (version(await handle.stat({ bigint: true })) !== version(st)) throw Error('文件在读取前变化');
    const bytes = await handle.readFile();
    if (version(await handle.stat({ bigint: true })) !== version(st) || version(await lstat(file, { bigint: true })) !== version(st) || normalize(await realpath(file)) !== normalize(file)) throw Error('文件在读取时变化');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { version: version(st), hash: digest(bytes), ...summaryDates(text) };
  } finally { await handle.close(); }
}

export function summaryCandidate(item, canonical, scope) {
  if (item.from !== 'memory-manager' || item.code !== 'R3' || item.status === 'resolved' || !canonical) return;
  const parts = JSON.parse(canonical);
  if (!Array.isArray(parts) || parts.length !== 6 || parts[3] !== scope || parts[4] !== 'summary-stale') return;
  const subject = parts[5];
  const expected = canonicalIssueIdentity({ from: item.from, code: item.code, identity: { scope, subtype: 'summary-stale', subject } });
  if (canonical !== expected || item.fingerprint !== stableIssueFingerprint(expected)) return;
  if (!safeSubject.test(subject) || /^functions\/(?:CON|PRN|NUL|AUX|(?:COM|LPT)\d)\.md$/i.test(subject)) throw Error('历史工单路径不符合直接功能文件约束');
  const dates = /^(.+) 头部状态摘要截至 (\d{4}-\d{2}-\d{2}) 早于最新迭代块 (\d{4}-\d{2}-\d{2})：追加迭代须成对刷新头部摘要$/.exec(item.message);
  if (!dates || dates[1] !== subject || !validDate(dates[2]) || !validDate(dates[3]) || dates[2] >= dates[3]) throw Error('历史工单证据与身份不一致');
  return { subject, originalNewest: dates[3] };
}

// Only the registered memory_check path supplies an actual completed scan.
export async function reconcileSummaries({ root, scope, inbox, snapshots, scanned, current }) {
  const outcomes = [];
  for (const { item, canonical } of snapshots) {
    try {
      const candidate = summaryCandidate(item, canonical, scope);
      if (!candidate || current.has(item.fingerprint)) continue;
      const { subject, originalNewest } = candidate;
      const slug = subject.slice('functions/'.length, -'.md'.length);
      if (!scanned.has(slug)) throw Error('本次完整检查未读到对应受管文件');
      const note = await withMemoryRootTransaction(root, async () => {
        const observation = await observe(root, scope, subject);
        if (observation.hash !== digest(scanned.get(slug))) throw Error('文件与本次体检读取版本不同');
        if (observation.head < observation.newest || observation.newest < originalNewest) throw Error('最新迭代块及摘要日期未能证实修复');
        const evidence = `${subject}：摘要截至 ${observation.head}，最新迭代块 ${observation.newest}；SHA-256 ${observation.hash}`;
        await inbox.resolveObserved(item, canonical, evidence, async () => {
          const latest = await observe(root, scope, subject);
          if (latest.version !== observation.version || latest.hash !== observation.hash) throw Error('证据版本已变化');
        });
        return evidence;
      });
      outcomes.push({ fingerprint: item.fingerprint, status: 'resolved', message: note });
    } catch (err) {
      outcomes.push({ fingerprint: item.fingerprint, status: err.code === 'INBOX_COMMIT_UNKNOWN' ? 'unknown' : 'unconfirmed', message: err.message });
    }
  }
  return outcomes;
}
