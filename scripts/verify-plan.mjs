/**
 * 计划书状态守卫（2026-11-10，用户要求"计划书进度要跟着更新"）。
 *
 * ## 为什么要机器核对
 *
 * 计划书是**对照文档**：节点做完要改状态、附证据。但"记得改"靠不住——
 * 2026-11-10 实测：III-3/4/5/6 全部落地后，F10/F18 还挂着 ⬜，
 * 进度汇总里我自己写的"✅ 13 项"也高于真实的 10 项。**文档自报的数字
 * 同样会错**，所以要用它在别处被锚定的东西反过来校验它。
 *
 * ## 核对什么（只核对能机器判定的）
 *
 * 1. **每条结论文档声称的计数 = 表格里实际标记数**（F 项 ✅/🔶/⬜）。
 *    这是最容易漂的一处，且不需要外部输入就能判。
 * 2. **节点表与验收表不矛盾**：节点表说某个 III-x 已完成，
 *    验收表里对应的 F 项就不能还是 ⬜。
 * 3. **正文里的状态声明 = 表格状态**（2026-11-20 新增，见下）。
 * 4. **不核对"证据是否真实"** —— 那需要读账本/跑命令，属于人工判断。
 *    守卫只保证"没有说谎的计数"。
 *
 * ## 为什么第 2 条改成从表里派生（2026-11-20）
 *
 * 原来这里是一张手写的 `NODE_TO_F` 映射表，注释还写着"守卫没覆盖 IV 是它
 * 自己的盲区，补上"——补的方式是再手写两项。**手写映射必然漏，漏了照样
 * 报 PASS**。实测：手写表只覆盖 8 个节点，而表里带「关联验收」列的节点有
 * 31 行。映射本来就写在文档里，直接读出来即可，不需要人维护。
 *
 * ## 为什么必须加第 3 条（2026-11-20 真实漏判）
 *
 * boss 问"到底哪些闭环了"，核对时发现阶段 IV 验收句写「F15（灰度）⬜」，
 * 而验收表 F15 是 ✅、IV-1 节点也是 ✅——**同一份文档自相矛盾，而守卫报
 * ALL PASS**。守卫原先只查表格之间的一致性，正文完全不在射程内；而恰恰是
 * 正文最容易在改表格时被忘记。这类"闸门只证没坏、不证该出现的出现了"，
 * 是本项目已经沉淀过的法，这次轮到自己的守卫失守。
 *
 * 列位一律**按表头文字定位**，不写死下标：F/N 表的状态在第 3 列，K 表在
 * 第 4 列（多一列"完成标志"）。写死下标会把 K 表读成"没有状态"，从而
 * 静默放过冲突——这是本轮实测踩到的第二个坑。
 *
 * 设计取舍：宁可少查，不可乱判。判不了的一律跳过而不是猜。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const ok = (cond, msg) => {
	console.log(`  ${cond ? 'PASS' : 'FAIL'} ${msg}`);
	if (!cond) failed++;
};

const plan = readFileSync(join(repo, 'UPGRADE-PLAN.md'), 'utf8');

console.log('\n--- 1. F 项状态计数 ---');
const fRows = [...plan.matchAll(/^\| (F\d+) \|.*$/gm)].map((m) => m[0]);
const count = { ok: 0, partial: 0, none: 0 };
for (const row of fRows) {
	if (/\| ✅ \|/.test(row)) count.ok++;
	else if (/\| 🔶 \|/.test(row)) count.partial++;
	else if (/\| ⬜ \|/.test(row)) count.none++;
}
ok(fRows.length === 19, `F 项共 ${fRows.length} 条（应为 19）`);
const sum = count.ok + count.partial + count.none;
ok(sum === fRows.length, `状态标记数 ${sum} = 行数 ${fRows.length}（没有未标状态的行）`);

// 汇总句里声称的数字必须与表格一致
const claimed = /✅ (\d+) 项/.exec(plan);
ok(claimed !== null, '汇总句含"✅ N 项"');
if (claimed) ok(Number(claimed[1]) === count.ok, `汇总声称 ✅ ${claimed[1]} 项 = 表格实际 ${count.ok} 项`);

console.log('\n--- 2. 节点表与验收表不矛盾（映射从表里派生，不手写）---');
// Locate columns BY HEADER TEXT. F/N tables put 状态 in column 3, the K table
// puts it in column 4 (it carries an extra 完成标志 column). Hard-coding an
// index silently reads the K table as "no status" and lets a conflict through
// — measured on 2026-11-20 while writing this rule.
const lines = plan.split('\n');
const cellsOf = (line) => line.split('|').map((c) => c.trim());
const isStatus = (s) => /^(✅|🔶|⬜)/u.test(s);
// Take the mark with a full match, never slice(0,1): 🔶 is a surrogate PAIR, so
// slicing yields half of it, isStatus then fails, and every 🔶 row is silently
// dropped as "no status". Measured: 21 of 30 rows derived, and the missing 9
// were exactly the 🔶 ones -- the guard would then report "referenced row does
// not exist" for F1/F2/F7/N3 and blame the document for its own bug.
const statusMark = (cell) => /^(✅|🔶|⬜)/u.exec(cell ?? '')?.[1];

const acceptanceStatus = new Map();
const nodeRows = [];
// A Markdown table's header is the line immediately above its separator row.
// Detecting headers that way (rather than carrying state across lines) means a
// table we do not care about can never leave stale column positions behind --
// the first version of this rule read 状态 by a fixed index, then recomputed
// 关联验收 per data row, and silently derived zero nodes.
const isSeparator = (line) => {
  const c = cellsOf(line);
  return line.trimStart().startsWith('|') && c.length > 2 && c.slice(1, -1).every((cell) => /^:?-{2,}:?$/.test(cell) || cell === '');
};
const STATUS_HEADER = /^(当前)?状态$/u;

const parseTable = (headerLine, refsHeader) => {
  const c = cellsOf(headerLine);
  const statusCol = c.findIndex((cell) => STATUS_HEADER.test(cell));
  const refsCol = refsHeader ? c.findIndex((cell) => cell === refsHeader) : -1;
  if (statusCol <= 0) return null;
  return { statusCol, refsCol, kind: c[1] };
};

for (let i = 0; i < lines.length - 1; i++) {
  if (!isSeparator(lines[i + 1])) continue;
  const cols = parseTable(lines[i], '关联验收');
  if (!cols) continue;
  for (let j = i + 2; j < lines.length; j++) {
    if (!lines[j].trimStart().startsWith('|')) break;
    const c = cellsOf(lines[j]);
    const mark = statusMark(c[cols.statusCol]);
    if (cols.kind === '编号' && /^[FNK]\d+$/.test(c[1])) {
      if (mark) acceptanceStatus.set(c[1], mark);
      continue;
    }
    if (cols.kind === '节点' && cols.refsCol > 0 && /^(I|II|III|IV|V|VI)-\d+(\.\d+)?\s/u.test(c[1])) {
      nodeRows.push({
        id: c[1].split(' ')[0],
        status: mark,
        // Ranges are real in this document (V-2 claims F2–F8), so expand them;
        // reading only the first id would under-claim and mis-flag orphans.
        refs: [...(c[cols.refsCol] ?? '').matchAll(/([FNK])(\d+)(?:[–—-](\d+))?/g)].flatMap((m) => {
          if (m[3]) {
            const from = Number(m[2]);
            const to = Number(m[3]);
            return Array.from({ length: to - from + 1 }, (_, k) => `${m[1]}${from + k}`);
          }
          return [`${m[1]}${m[2]}`];
        }),
      });
    }
  }
}

ok(nodeRows.length >= 28, `派生出 ${nodeRows.length} 行节点（手写映射原先只覆盖 8 行）`);
ok(acceptanceStatus.size >= 30, `派生出 ${acceptanceStatus.size} 行验收状态（含 K 表）`);

let nodeViolations = 0;
for (const node of nodeRows) {
  if (node.status !== '✅') continue;
  for (const ref of node.refs) {
    const st = acceptanceStatus.get(ref);
    if (st === undefined) { ok(false, `${node.id} 引用了不存在的验收行 ${ref}`); nodeViolations++; continue; }
    if (st === '⬜') { ok(false, `${node.id} 标 ✅，但它声称达成的 ${ref} 仍是 ⬜`); nodeViolations++; }
  }
}
ok(nodeViolations === 0, `${nodeRows.filter((n) => n.status === '✅').length} 个已完成节点引用的验收项均非 ⬜`);

console.log('\n--- 2b. 正文里的状态声明必须等于表格状态 ---');
// The gap that this closes: 阶段 IV 验收句写「F15（灰度）⬜」而验收表 F15 是
// ✅、IV-1 也是 ✅。同一份文档自相矛盾，旧守卫照样报 ALL PASS——因为它只比
// 表格之间，正文不在射程内，而改表格时最容易忘的就是正文那句。
// Whitelist the connector rather than blacklist it: "K1–K5 全 ✅ 才算收口" is
// a condition, not a status claim, and must not be read as one.
const PROSE_STATUS = /([FNK]\d+)(?:（[^）]{1,14}）)?\s*(?:为|是|[:：=＝])?\s*(✅|🔶|⬜)/gu;
let proseChecked = 0;
let proseConflicts = 0;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trimStart().startsWith('|')) continue;
  for (const m of lines[i].matchAll(PROSE_STATUS)) {
    const [, id, claimed] = m;
    const actual = acceptanceStatus.get(id);
    if (actual === undefined) continue; // an id with no table row is not comparable here
    proseChecked++;
    if (actual !== claimed) {
      proseConflicts++;
      ok(false, `正文 L${i + 1} 说 ${id} ${claimed}，验收表是 ${actual}`);
    }
  }
}
ok(proseChecked >= 6, `正文状态声明比对 ${proseChecked} 处（少于 6 说明规则没真正读到东西）`);
ok(proseConflicts === 0, '正文与验收表的状态声明无冲突');

console.log('\n--- 2c. 验收表里标 ✅ 的项必须被某个已完成节点声称 ---');
// An ✅ with no node behind it is a green light nobody produced. F6/N2/N6 are
// legitimately reached by mechanisms outside the node tables, so they are
// listed here as DECLARED exceptions: adding one requires a reason, and
// removing the reason is what the check is for.
const UNNODELED_OK = new Set(['F6', 'N2', 'N6']);
const claimedByDone = new Set(nodeRows.filter((n) => n.status === '✅').flatMap((n) => n.refs));
for (const [id, st] of acceptanceStatus) {
  if (st !== '✅' || claimedByDone.has(id) || UNNODELED_OK.has(id)) continue;
  ok(false, `${id} 标 ✅ 但没有任何 ✅ 节点声称达成它（若确属表外机制，请加入 UNNODELED_OK 并写明理由）`);
}

console.log('\n--- 3. 已知未走完闭环的项不得被误标完成 ---');
// III-1 治理循环：机制在，但"真实反例驱动的失效提议"还没发生过，
// 且它的定时触发刚由 III-7 补上、尚未跑过一轮真实周期。所以它是 🔶。
// 这条断言的作用：等哪天真的走完一次，改成 ✅ 时**必须同时删掉这条守卫**
// ——强制重新审视，而不是顺手把 ⬜ 改成 ✅。
const iii1 = plan.split('\n').find((l) => l.startsWith('| III-1 '));
ok(iii1 !== undefined, 'III-1 行存在');
ok(!iii1.includes('✅'), 'III-1 治理循环尚未走完一次真实闭环，不得标 ✅（若确实走完，请同步删除本守卫）');

// Check exact status for every explicitly listed node, not only done/not-done.
// Alternation is necessary: 🔶 is a surrogate pair and a character class would
// match only half of it without Unicode mode.
for (const [stage, nodes] of [
	['I', ['I-1', 'I-2', 'I-3', 'I-4', 'I-5']],
	['II', ['II-1', 'II-2', 'II-3', 'II-4', 'II-5']],
	['III', ['III-1', 'III-2', 'III-3', 'III-4', 'III-5', 'III-6', 'III-7']],
	['IV', ['IV-1', 'IV-2', 'IV-3', 'IV-4', 'IV-5']],
]) {
	const summaryRow = plan.split('\n').find((line) => line.startsWith(`| ${stage} · `));
	ok(summaryRow !== undefined, `进度汇总含 ${stage} 行`);
	if (!summaryRow) continue;
	for (const node of nodes) {
		const row = plan.split('\n').find((line) => line.startsWith(`| ${node} `));
		const m = new RegExp(`${node}\\s*(✅|🔶|⬜)`, 'u').exec(summaryRow);
		const cells = row?.split('|').map((cell) => cell.trim()) ?? [];
		const nodeStatus = /^(✅|🔶|⬜)/u.exec(cells.at(-2) ?? '')?.[1];
		ok(m !== null && nodeStatus !== undefined, `${node} 汇总和节点均有状态`);
		if (m && nodeStatus) ok(m[1] === nodeStatus, `${node} 汇总(${m[1]}) 与节点(${nodeStatus})一致`);
	}
}

console.log(failed === 0 ? '\nplan-check: ALL PASS' : `\nplan-check: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
