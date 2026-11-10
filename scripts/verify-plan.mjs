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
 * 2. **阶段 III 节点表与验收表不矛盾**：节点表说某个 III-x 已完成，
 *    验收表里对应的 F 项就不能还是 ⬜。
 * 3. **不核对"证据是否真实"** —— 那需要读账本/跑命令，属于人工判断。
 *    守卫只保证"没有说谎的计数"。
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

console.log('\n--- 2. 阶段 III 节点表与验收表不矛盾 ---');
// 节点表：III-x 行里若出现 ✅，则验收表对应 F 项不能是 ⬜
const III_TO_F = {
	'III-1': 'F1',
	'III-2': 'F19',
	'III-3': 'F10',
	'III-4': 'F10',
	'III-5': 'F10',
	'III-6': 'F18',
};
for (const [node, f] of Object.entries(III_TO_F)) {
	const row = plan.split('\n').find((l) => l.startsWith(`| ${node} `));
	if (!row) {
		ok(false, `找不到节点行 ${node}`);
		continue;
	}
	const done = row.includes('✅');
	if (!done) {
		console.log(`  SKIP ${node} 未标完成，不比对`);
		continue;
	}
	const fRow = plan.split('\n').find((l) => l.startsWith(`| ${f} `));
	ok(fRow !== undefined, `${node} 对应的 ${f} 存在于验收表`);
	if (fRow) ok(!/\| ⬜ \|/.test(fRow), `${node} 已完成 → ${f} 不能仍标 ⬜`);
}

console.log('\n--- 3. 已知待建项不得被误标完成 ---');
// III-7 定时巡检确实未建；若有人把它标成 ✅ 而没证据，这里会红。
const iii7 = plan.split('\n').find((l) => l.startsWith('| III-7 '));
ok(iii7 !== undefined, 'III-7 行存在');
ok(!iii7.includes('✅'), 'III-7 定时巡检尚未实现，不得标 ✅');

console.log(failed === 0 ? '\nplan-check: ALL PASS' : `\nplan-check: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
