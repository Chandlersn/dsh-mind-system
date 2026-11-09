/**
 * 一次性变异验证：逐条改坏判据 → 跑测试 → 必须红 → 恢复 → 必须绿。
 * 跑完自删由调用方负责。产物只写临时副本，不碰源文件。
 */
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const pkg = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(pkg, '..', '..');

const MUTATIONS = [
	{ file: 'src/predicates.js', find: "if (c.success_evidence !== 'external') return reject('success_not_external');", replace: '', label: '去掉外部证据强制' },
	{ file: 'src/predicates.js', find: 'if (c.repeats < t.skillMinRepeats)', replace: 'if (c.repeats < 0)', label: '重复阈值失效' },
	{ file: 'src/predicates.js', find: 'if (ti !== fi - 1) return reject(\'non_adjacent_ascent\');', replace: '', label: '允许跳层上行' },
	{ file: 'src/predicates.js', find: "if (hits.length > 0) {", replace: 'if (false) {', label: '黑名单永不命中' },
	{ file: 'src/store.js', find: "const outcome = decision.action", replace: 'const outcome = decision.action', label: '(placeholder)' },
];
// 第 5 条真正的变异在 index.js（记账侧）
MUTATIONS[4] = { file: 'index.js', find: "const outcome = decision.action === 'deny' || decision.action === 'reject' ? 'skipped' : 'admitted';", replace: "const outcome = 'admitted';", label: '拒绝侧不落 skipped（漏判分母消失）' };
// 提名器变异（阶段 II）：
MUTATIONS.push(
	{ file: 'src/nominate.js', find: 'if (agg.count < t.forbiddenMinFailures) continue;', replace: '', label: '负向提名阈值失效（1 次失败也提名）' },
	{ file: 'src/nominate.js', find: "if (!href.startsWith('functions/')) continue;", replace: '', label: '正向提名越层（insights 也被提名）' },
	{ file: 'src/nominate.js', find: "success_evidence: 'self_report',", replace: "success_evidence: 'external',", label: '提名器伪造外部证据级别' },
	{ file: 'src/store.js', find: "if (origin === 'daily') dailyCount++;", replace: 'dailyCount++;', label: 'origin 口径失效（验证样本灌进日常计数）' },
	{ file: 'index.js', find: 'if (seen.has(key)) continue;', replace: '', label: 'clisTrace 幂等失效（重复消费重复落账）' },
	{ file: 'src/clis-bridge.js', find: "const inContract = CAUSAL_TYPES.includes(type);", replace: 'const inContract = true;', label: '离契约类型被当合规提名放行' },
	{ file: 'src/clis-bridge.js', find: "if (text.includes('⚠️ 已被取代')) continue;", replace: '', label: '已取代原则重新进入候选' },
	{ file: 'src/clis-bridge.js', find: "const ve = parseValveEvidenceSection(text);", replace: 'const ve = undefined;', label: '证据节永不读回（补证白补，永远 downgrade）' },
	{ file: 'src/clis-bridge.js', find: "const section = text.split('## 阀门证据')[1]?.split(/\\n## /)[0];", replace: "const section = text.split('## 阀门证据')[1];", label: '证据节越界（下一节的行混入量化）' },
	{ file: 'src/governance.js', find: 'coverage: total >= minSample ? Number((cited / total).toFixed(3)) : null,', replace: 'coverage: total ? Number((cited / total).toFixed(3)) : null,', label: '覆盖率小样本保护失效（3 条也出数触发假失效）' },
	{ file: 'src/governance.js', find: "if (!origins.has(origin)) continue;", replace: '', label: '覆盖率 origin 过滤失效（验证样本灌分母）' },
	{ file: 'src/governance.js', find: 'if (nomination.confidence < minConfidence) {', replace: 'if (false) {', label: '归类置信度门槛失效（低置信度不转人工）' },
	{ file: 'src/governance.js', find: "human_gate_required: humanGate || proposals.length > 0,", replace: 'human_gate_required: false,', label: '改定义提议绕过人工闸门' },
	{ file: 'src/governance.js', find: 'const effectiveCoverage = coldStart ? null : coverage;', replace: 'const effectiveCoverage = coverage;', label: '冷启动保护失效（无 refs 历史被判假失效）' },
);

let red = 0;
for (const m of MUTATIONS) {
	const sandbox = mkdtempSync(join(tmpdir(), 'dsh-valves-mut-'));
	const dir = join(sandbox, 'dsh-valves');
	try {
		cpSync(pkg, dir, { recursive: true, filter: (s) => !s.includes('node_modules') });
		// 桥测试引用 ../../dsh-memory-manager —— 在同一个私有沙箱里复制该 src
		cpSync(join(pkg, '..', 'dsh-memory-manager', 'src'), join(sandbox, 'dsh-memory-manager', 'src'), { recursive: true });
		const target = join(dir, m.file);
		const text = readFileSync(target, 'utf8');
		if (!text.includes(m.find)) {
			console.log(`MISS ${m.label}: 找不到靶片段（源已变化）`);
			process.exitCode = 1;
			continue;
		}
		writeFileSync(target, text.replace(m.find, m.replace), 'utf8');
		const r = spawnSync(process.execPath, ['--test', 'test/predicates.test.js', 'test/store.test.js', 'test/entry.test.js', 'test/nominate.test.js', 'test/clis-bridge.test.js', 'test/governance.test.js'], { cwd: dir, encoding: 'utf8' });
		const killed = r.status !== 0;
		console.log(`${killed ? 'RED ' : 'GREEN(!!)'} ${m.label}`);
		if (killed) red++;
		else process.exitCode = 1;
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
}
console.log(`\n变异结果：${red}/${MUTATIONS.length} 被杀死`);
if (red !== MUTATIONS.length) process.exitCode = 1;