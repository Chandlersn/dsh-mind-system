/**
 * 提交前的隐私检查：待入库的 reports/ 里有没有不该提交的东西。
 *
 * 判据（三条，都是"有就该拦"）：
 *   1. 凭据形态（sk-/ghp_/token= 之类）
 *   2. 用户主目录绝对路径（暴露本机目录结构）
 *   3. 采样文件原文（采样本身只存判定，但实验答案里可能带路径）
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = process.argv[2] ?? 'reports';
const CRED = [/sk-[A-Za-z0-9]{16,}/g, /ghp_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /Bearer\s+[A-Za-z0-9._-]{30,}/g];
const USERPATH = /[A-Za-z]:[\\/]+Users[\\/]+([^\\/"'\s]+)/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(root);
let credHits = 0;
let pathHits = 0;
const userNames = new Set();
const credFiles = [];

for (const f of files) {
  const ext = extname(f);
  if (!['.json', '.md', '.html', '.txt', '.mjs', '.log'].includes(ext)) continue;
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }

  for (const re of CRED) {
    const m = text.match(re);
    if (m) { credHits += m.length; credFiles.push(f); }
  }
  for (const m of text.matchAll(USERPATH)) userNames.add(m[1]);
}

console.log(`扫描 ${files.length} 个文件`);
console.log(`凭据形态命中: ${credHits}${credHits > 0 ? '  ← 必须处理' : '（无）'}`);
if (credFiles.length > 0) for (const f of [...new Set(credFiles)].slice(0, 5)) console.log(`   ${f}`);
console.log(`用户目录名出现: ${userNames.size} 种  ${[...userNames].join(', ')}`);
console.log('');
console.log('判定：');
if (credHits > 0) {
  console.log('  ✗ 有凭据形态 —— 不要提交，先清理');
  process.exitCode = 1;
} else if (userNames.size > 0) {
  console.log(`  ⚠ 只有用户名 "${[...userNames].join(',')}" 出现在路径里（本机目录结构）。`);
  console.log('    这不是凭据，但会暴露本机布局。reports 是实验证据，通常可接受；');
  console.log('    如不希望公开，应在提交前脱敏或把 reports 加入 .gitignore。');
} else {
  console.log('  ✓ 未发现凭据或用户路径');
}
