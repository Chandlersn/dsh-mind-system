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
	// III-3 预算缰绳（2026-11-10）：
	{ file: 'src/budget.js', find: 'const overItems = items > budget.maxItems;', replace: 'const overItems = false;', label: '条目预算上限失效（多少条都放行）' },
	{ file: 'src/budget.js', find: 'const overRows = rows > budget.maxLedgerRows;', replace: 'const overRows = false;', label: '账本行预算上限失效' },
	{ file: 'src/budget.js', find: 'if (!overItems && !overRows) return { ok: true };', replace: 'if (true) return { ok: true };', label: '预算判定恒放行（缰绳等于没有）' },
	{ file: 'src/budget.js', find: 'if (items < 0 || rows < 0) {', replace: 'if (false) {', label: '负规模不报错（算错与超限混为一谈）' },
	{ file: 'src/budget.js', find: 'for (let i = 0; i < all.length; i += size) out.push(all.slice(i, i + size));', replace: 'out.push(all.slice(0, size));', label: '分批丢数据（只保留第一批）' },
	// III-4 回滚缰绳（2026-11-10）：
	{ file: 'src/store.js', find: 'const snap = await writeSnapshot(storageDir, id, prev);', replace: 'const snap = { ok: true, n: 0 };', label: '写入前不快照（错的禁令再也退不回去）' },
	{ file: 'src/store.js', find: "if (!snap.ok) {", replace: 'if (false) {', label: '快照失败仍写入（制造回不去的状态）' },
	{ file: 'src/store.js', find: 'await markSnapshotConsumed(storageDir, id, latest.n);', replace: '', label: '不标记快照已消费（回退重复恢复同一版）' },
	{ file: 'src/snapshot.js', find: 'if (parsed?.consumed_at) continue;', replace: '', label: '读快照不排除已消费（第二次回退读到同一条）' },
	{ file: 'src/snapshot.js', find: 'const count = Number.isFinite(used) ? used : await rollbackCount(storageDir, ruleId);', replace: 'const count = Number.isFinite(used) ? used : (await snapshotNumbers(storageDir, ruleId)).length;', label: '回退次数用快照总数冒充（改过三次就拒回退）' },
	{ file: 'src/snapshot.js', find: 'if (count >= max) {', replace: 'if (false) {', label: '回退上限失效（无限自动回退）' },
	{ file: 'src/snapshot.js', find: "return String(ruleId ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || '_';", replace: "return String(ruleId ?? '');", label: '规则 id 不中性化（路径可能逃出快照目录）' },
	// III-5 越权拦截（2026-11-10）：
	{ file: 'src/guard.js', find: "if (!HUMAN_CHANNELS.includes(via)) {", replace: 'if (false) {', label: '任意通道都能签票（候选可自我确认生效）' },
	{ file: 'src/guard.js', find: "if (!t) {", replace: 'if (false) {', label: '无票放行（写入不校验人工确认）' },
	{ file: 'src/guard.js', find: 'if (now - p.at > PERMIT_TTL_MS) {', replace: 'if (false) {', label: '过期票仍可用' },
	{ file: 'src/guard.js', find: 'if (p.ruleId !== ruleId) {', replace: 'if (false) {', label: '票不绑定规则（拿 A 的票写 B）' },
	{ file: 'src/guard.js', find: "return permits.delete(t);", replace: 'return true;', label: '票可重复使用（一次性失效）' },
	{ file: 'src/guard.js', find: 'if (list.length === 0) {', replace: 'if (false) {', label: '跳过判据不拦（空判据也算跑过）' },
	{ file: 'src/guard.js', find: "if (!options.allowLayers.includes(options.layer)) {", replace: 'if (false) {', label: '越层写入不拦' },
	{ file: 'src/store.js', find: "} else if (options.human !== true) {", replace: "} else if (false) {", label: 'store 不检查人工声明（无票直写）' },
	// III-6 语义越权（2026-11-10）：
	{ file: 'src/semantic.js', find: 'blocked: false,', replace: 'blocked: true,', label: '语义标记变成阻断（会误杀正当路径）' },
	// 注意：N4 短路是**双层**的（detect 的外层 + semanticSimilarity 的内层），
	// 单变异任何一层都杀不死——这正是冗余保护的价值。这里变内层（最终防线）。
	{ file: 'src/semantic.js', find: "if (typeof embed !== 'function') {", replace: 'if (false) {', label: '最终防线失效（内层不再判 embedder 类型）' },
	{ file: 'src/semantic.js', find: 'if (na === 0 || nb === 0) return null;', replace: 'if (false) return null;', label: '零向量硬算相似度（除零）' },
	{ file: 'src/semantic.js', find: "if (kw && t.includes(kw)) hits.push", replace: 'if (false) hits.push', label: '词面层永不命中（语义层唯一依赖变成硬依赖）' },
	{ file: 'src/semantic.js', find: 'if (lexical.hits.length > 0) {', replace: 'if (false) {', label: '词面命中不进理由（标记失去证据）' },
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
		const r = spawnSync(process.execPath, ['--test', 'test/predicates.test.js', 'test/store.test.js', 'test/entry.test.js', 'test/nominate.test.js', 'test/clis-bridge.test.js', 'test/governance.test.js', 'test/budget.test.js', 'test/snapshot.test.js', 'test/guard.test.js', 'test/semantic.test.js'], { cwd: dir, encoding: 'utf8' });
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