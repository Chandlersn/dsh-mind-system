/**
 * 回滚缰绳（III-4）：规则生效前快照 + 回退到上一版 + 回退次数上限。
 *
 * ## 为什么需要它
 *
 * `confirmNegativeRule` 是**覆盖式写入**：同 id 的新规则直接顶掉旧的。
 * 一旦写进一条错的禁令，它就会立刻开始拦截所有匹配的路径——而覆盖前的
 * 那个版本**已经不存在了**，没有任何办法退回。禁令错了会拦住本来正确的
 * 做法，这类事故比"没生效"严重得多。
 *
 * 所以写入前必须快照。快照不是为了"以后可能有用"，是**回退的唯一依据**。
 *
 * ## 回退上限 3 次（按规则计，不是全局）
 *
 * 同一条规则被回退三次，说明问题不在那一次写错，而在**它本身的判据不稳**
 * （关键词选得不对、场景边界没想清）。再自动回退只是让人舒服地重复同一个
 * 错误。第三次之后转人工：由人决定是精炼这条规则、还是废弃它。
 *
 * 计的是**规则 id**，不是全局次数——A 规则回退 2 次、B 规则回退 2 次，
 * 各自都还没到上限，不该因为总数 4 就停掉 B。
 *
 * ## 存储
 *
 * `<dshHome>/storages/mind-rule-snapshots/<ruleId>.<n>.json`，n 递增。
 * 与其把历史塞进规则库本身（让每个读者都得处理嵌套历史），不如放同目录
 * 的独立文件：规则库保持"当前生效态"的单一职责，快照是旁路档案。
 *
 * @module src/snapshot
 */
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** 同一规则最多自动回退几次，之后转人工。 */
export const MAX_ROLLBACKS = 3;

/**
 * 快照存放目录。
 * @param {string} storageDir storages 根。
 * @returns {string} 绝对路径。
 */
export function snapshotDir(storageDir) {
	return join(storageDir, 'mind-rule-snapshots');
}

/**
 * 某条规则已有的快照编号列表（升序）。
 *
 * 用文件名解析而不是索引文件：多一个索引就多一份会和实际文件不同步的状态。
 *
 * @param {string} storageDir storages 根。
 * @param {string} ruleId 规则 id。
 * @returns {Promise<number[]>} 编号升序；目录不存在时返回 []。
 */
export async function snapshotNumbers(storageDir, ruleId) {
	const safe = safeName(ruleId);
	let names;
	try {
		names = await readdir(snapshotDir(storageDir));
	} catch (err) {
		if (err?.code === 'ENOENT') return [];
		throw err;
	}
	const out = [];
	for (const n of names) {
		const m = /^(.+)\.(\d+)\.json$/.exec(n);
		if (!m || m[1] !== safe) continue;
		out.push(Number(m[2]));
	}
	return out.sort((a, b) => a - b);
}

/** 规则 id 里可能有路径分隔符等，落成文件名前必须先中性化。 */
function safeName(ruleId) {
	return String(ruleId ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || '_';
}

/**
 * 写入一条快照（规则生效**前**的状态）。
 *
 * @param {string} storageDir storages 根。
 * @param {string} ruleId 规则 id。
 * @param {object|null} rule 生效前的规则对象；null 表示"此前不存在"。
 * @returns {Promise<{ok: boolean, n?: number, error?: string}>}
 */
export async function writeSnapshot(storageDir, ruleId, rule) {
	const id = String(ruleId ?? '').trim();
	if (!id) return { ok: false, error: '快照需要 ruleId' };
	try {
		const nums = await snapshotNumbers(storageDir, id);
		const n = (nums[nums.length - 1] ?? 0) + 1;
		const dir = snapshotDir(storageDir);
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, `${safeName(id)}.${n}.json`),
			`${JSON.stringify({ rule_id: id, n, taken_at: new Date().toISOString(), rule }, null, 2)}\n`,
			'utf8',
		);
		return { ok: true, n };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 读最新一条**未被消费**的快照 —— 回退时"上一版"的来源。
 *
 * ## 为什么要排除已消费的（2026-11-10 实测抓到）
 *
 * 回退本身不改快照文件，于是"读最新"会一直读到同一条：回退两次仍然恢复
 * 同一版，第二次回退看起来成功、实际什么都没变。所以回退成功后在快照里
 * 标 `consumed_at`，读"上一版"时跳过它——第二次回退才会走到更早的那一版。
 *
 * @param {string} storageDir storages 根。
 * @param {string} ruleId 规则 id。
 * @returns {Promise<{ok: boolean, rule?: object|null, n?: number, error?: string}>}
 *   `rule: null` 表示上一版是"不存在"（即这条规则原本没有，回退等于删掉它）。
 */
export async function readLatestSnapshot(storageDir, ruleId) {
	const id = String(ruleId ?? '').trim();
	if (!id) return { ok: false, error: '需要 ruleId' };
	let nums;
	try {
		nums = await snapshotNumbers(storageDir, id);
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	if (nums.length === 0) return { ok: false, error: 'no_snapshot' };
	const file = (n) => join(snapshotDir(storageDir), `${safeName(id)}.${n}.json`);
	// 从新到旧找第一条未消费的
	for (let i = nums.length - 1; i >= 0; i--) {
		const n = nums[i];
		try {
			const parsed = JSON.parse(await readFile(file(n), 'utf8'));
			if (parsed?.consumed_at) continue;
			return { ok: true, rule: parsed?.rule ?? null, n };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	}
	return { ok: false, error: 'all_snapshots_consumed' };
}

/**
 * 把一条快照标记为已消费（回退成功后调用）。
 *
 * @param {string} storageDir storages 根。
 * @param {string} ruleId 规则 id。
 * @param {number} n 快照编号。
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function markSnapshotConsumed(storageDir, ruleId, n) {
	const id = String(ruleId ?? '').trim();
	if (!id || !Number.isFinite(n)) return { ok: false, error: '需要 ruleId 与编号' };
	const file = join(snapshotDir(storageDir), `${safeName(id)}.${n}.json`);
	try {
		const parsed = JSON.parse(await readFile(file, 'utf8'));
		parsed.consumed_at = new Date().toISOString();
		await writeFile(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
		return { ok: true };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * 已回退次数 = **已消费**的快照数。
 *
 * ## 为什么不能用"快照总数"近似（实测抓到的 bug）
 *
 * 快照是每次确认写一条，回退只消费其中一条。用快照总数当回退次数，
 * 等于把"改过的次数"冒充"退回的次数"——三次正常修订后第一次想回退，
 * 就会被判成"已回退 3 次"直接拒绝。两者是完全不同的计数。
 *
 * @param {string} storageDir storages 根。
 * @param {string} ruleId 规则 id。
 * @returns {Promise<number>} 已消费快照数（目录不存在按 0）。
 */
export async function rollbackCount(storageDir, ruleId) {
	const id = String(ruleId ?? '').trim();
	if (!id) return 0;
	let nums;
	try {
		nums = await snapshotNumbers(storageDir, id);
	} catch {
		return 0;
	}
	let used = 0;
	for (const n of nums) {
		try {
			const parsed = JSON.parse(await readFile(join(snapshotDir(storageDir), `${safeName(id)}.${n}.json`), 'utf8'));
			if (parsed?.consumed_at) used++;
		} catch {
			/* 坏快照不计入 */
		}
	}
	return used;
}

/**
 * 判定还能不能继续自动回退。
 *
 * @param {string} storageDir storages 根。
 * @param {string} ruleId 规则 id。
 * @param {number} [used] 已回退次数；缺省按**已消费的快照数**算（不是快照总数）。
 * @returns {Promise<{allowed: boolean, used: number, max: number, reason?: string}>}
 */
export async function canRollback(storageDir, ruleId, used) {
	const max = MAX_ROLLBACKS;
	const count = Number.isFinite(used) ? used : await rollbackCount(storageDir, ruleId);
	if (count >= max) {
		return {
			allowed: false,
			used: count,
			max,
			// 到上限不是"出错了"，是该换一种修法了 —— 提示语要让人知道下一步。
			reason: 'rollback_limit_reached',
		};
	}
	return { allowed: true, used: count, max };
}
