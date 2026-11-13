/**
 * 层级写入守卫（2026-11-10 用户要求）。
 *
 * 原要求：层级数据由插件通道写入；2026-11-13 用户调整：每日原始层允许
 * 编辑工具写入并用提示词粗筛，其他层的约束保持不变。
 *
 * `src/write-ledger.js` 做的是**事后对账**（R26 点名），只能发现当前内容与
 * 账本不一致或未记录，不能证明写入者。这里仅对部分编辑工具做前向拦截。
 *
 * 宿主 `tools/execute` 是包裹式 waterfall，调用 next 才执行后续工具。
 * 这里检查 write/edit 和 str_replace_editor 写命令的实际参数，使用宿主 fs 与工作目录服务解析后再决定。
 * `fs/*-intent` 是单槽 first-wins，已有监听器可能使后续守卫完全不运行。
 *
 * ## 拦哪些、放哪些（判据不是"记忆根内一律禁写"）
 *
 * 拦：
 *   - `MEMORY.md`（索引是派生物，只能由 memory_index / 插件落盘）
 *   - `functions/ insights/ dao/ capabilities/ legacy/` 下的任何文件（含 dao/_candidates）
 *   - 宿主技能根（默认 `<dshHome>/skills`，可由宿主配置覆盖）的目录项及后代。
 *   - 记忆根顶层的 `*.jsonl` 旁路账本（.write-ledger / .usage：被改就对不了账）
 *   - 采集协议私有元数据 `.capture-mutex.sqlite`、其 journal/wal/shm 和 `.daily-capture.pending`。
 *
 * 放：
 *   - 根目录每日记录 `<root>/YYYY-MM-DD.md`：内容筛选由提示词引导，不作为硬拦截。
 *   - `daily/YYYY-MM.md`（月/周归档，2026-11）：归档文件也是数据文件，允许
 *     编辑工具维护；daily/ 下其他名字仍拒。
 *   - 根目录其它文档（README.md 之类）：不承载层级数据，不走层闸门。
 *   - 记忆根和宿主技能根以外的路径：本守卫不管其他位置。
 *
 * ## 边界（诚实标注）
 *
 * - 这是**工具层**守卫：bash 里 `Set-Content` / 脚本写文件不经过 `ctx.fs`，
 *   拦不住。真正的文件系统级封锁要宿主沙箱配合（当前 workspace-write 只管
 *   工作区内外，不认"记忆根"这个语义）。工具拦截和体检对账都不能证明来源，
 *   也不构成同权限进程无法绕过的安全隔离。
 * - 仅检查经宿主调度的 write/edit 和 str_replace_editor 写命令；shell 和其他写入途径不受此守卫限制。
 * - 对有效路径无法解析时拒绝这次调用，避免把未知目标误判成安全路径。
 *
 * @module src/write-guard
 */
import path from 'node:path';
import { dshHome } from './util.js';

/** 受守卫保护的层目录（相对记忆根第一段）。 */
export const GUARDED_ZONES = Object.freeze(['functions', 'insights', 'dao', 'capabilities', 'legacy', 'skills', 'daily']);

/** 索引文件：派生物，只能由 memory_index / 插件写。 */
export const INDEX_FILE = 'MEMORY.md';

/** 稳定错误代号（日志/测试共用）。 */
export const WRITE_DENIED = 'MEMORY_LAYER_WRITE_DENIED';

/** 根目录每日记录文件名，与账本的严格键匹配保持一致。 */
const DAILY_RE = /^\d{4}-\d{2}-\d{2}\.md(?![\s\S])/;

/**
 * 按月归档文件名（daily/ 下唯一放行的形态）。
 *
 * 月/周折叠方案（2026-11）：归档文件也是数据文件，由插件归档通道维护并
 * 经写入账本登记，允许编辑工具做人为修正；daily/ 下其他名字一律仍拒。
 */
const DAILY_MONTH_RE = /^\d{4}-\d{2}\.md(?![\s\S])/;

/** 顶层旁路账本（被改就对不了账）。 */
const LEDGER_RE = /^[^/\\]+\.jsonl$/i;

/** 采集插件私有协议文件（精确文件名；大小写按 Windows 文件名语义匹配）。 */
const CAPTURE_METADATA_RE = /^(?:\.capture-mutex\.sqlite(?:-(?:journal|wal|shm))?|\.daily-capture\.pending)(?![\s\S])/i;

/**
 * 把 FsTarget 还原成可比较的绝对路径。
 *
 * `displayPath` 在本地后端就是绝对路径；拿不到绝对路径时退回 `targetKey`
 * （本地后端同样是 realpath）。两者都不是绝对路径时返回 `undefined`——
 * 判不了时调用方应拒绝执行，不猜。
 *
 * @param {object} target FsTarget。
 * @returns {string|undefined}
 */
export function targetPath(target) {
	const candidates = [target?.displayPath, target?.targetKey];
	for (const c of candidates) {
		if (typeof c !== 'string' || c.trim() === '') continue;
		const p = c.trim();
		if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return path.resolve(p);
	}
	return undefined;
}

/**
 * 判定一个绝对路径在记忆根内的归属。
 *
 * @param {string} root 记忆根绝对路径。
 * @param {string} abs 目标绝对路径。
 * @returns {{block: boolean, key?: string, reason?: string}}
 *   `block=true` 时 `key` 是账本口径的相对键，`reason` 说明拦它是因为
 *   索引 / 层目录 / 账本 哪一类。
 */
export function classifyWrite(root, abs) {
	const rootAbs = path.resolve(String(root ?? ''));
	const target = path.resolve(String(abs ?? ''));
	const rel = path.relative(rootAbs, target);
	// 根外 / 根自身：不归本守卫管。
	if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { block: false };
	const key = rel.split(path.sep).join('/');
	const parts = key.split('/');
	const top = parts[0];

	// 原始每日记录允许编辑；其他路径和独立技能根仍分别检查。
	if (parts.length === 1 && DAILY_RE.test(top)) return { block: false, key, reason: 'daily' };
	// 月/周归档（2026-11）：daily/YYYY-MM.md 也是数据文件，放行；daily/ 下
	// 其他名字（含 daily/YYYY-MM-DD.md 等非月形）仍按层目录拒绝。
	if (parts.length === 2 && parts[0] === 'daily' && DAILY_MONTH_RE.test(parts[1])) return { block: false, key, reason: 'daily-archive' };
	// 索引：派生物。
	if (parts.length === 1 && top.toLowerCase() === INDEX_FILE.toLowerCase()) {
		return { block: true, key, reason: 'index' };
	}
	// 层目录（含子目录，如 dao/_candidates/…）。
	if (GUARDED_ZONES.includes(process.platform === 'win32' ? top.toLowerCase() : top)) return { block: true, key, reason: 'layer' };
	// 顶层旁路账本和采集协议私有元数据。
	if (parts.length === 1 && LEDGER_RE.test(top)) return { block: true, key, reason: 'ledger' };
	if (parts.length === 1 && CAPTURE_METADATA_RE.test(top)) return { block: true, key, reason: 'capture-metadata' };
	return { block: false };
}

/**
 * 拒绝写入时给模型看的说明——必须**可行动**，否则只会被当成又一个红叉。
 *
 * @param {string} key 相对键。
 * @param {string} reason 归类。
 * @returns {string}
 */
export function denialMessage(key, reason) {
	const hint =
		reason === 'index'
			? 'MEMORY.md 是索引派生物：请用 memory_index（功能域稳定后收行）'
			: reason === 'ledger'
				? '旁路账本只能由插件追加；它被改过，R26 对账就失效了'
				: reason === 'capture-metadata'
					? '采集协议元数据是插件私有文件，只能由插件采集通道维护'
				: reason === 'skill'
					? '宿主技能目录只能通过插件提供的 memory_skill 等写入通道维护'
					: '层级内容只能由 memory_* 工具落盘（memory_write / memory_insight / memory_dao / memory_capability / memory_fold / memory_rename / memory_usage）';
	return `拒绝写入 ${key}：${hint}。直接编辑会绕过层级判据与蒸馏闸门（R14/R2）。`;
}

/** Guard the host's around-dispatch hook; resolve paths as dsh-tool-fs does. */
export function createWriteGuard(getRoot, ctx, getSkillRoot = () => path.join(dshHome(), 'skills')) {
	return async function guardToolExecution(exec, next) {
		const editor = exec?.name === 'str_replace_editor';
		if (exec?.name !== 'write' && exec?.name !== 'edit' && !editor) return next();
		// The editor's view command is read-only; its three mutation commands use path.
		if (editor && exec.arguments?.command === 'view') return next();
		const requested = editor ? exec.arguments?.path : exec.arguments?.file_path;
		// Leave invalid arguments to the tool's own validation.
		if (typeof requested !== 'string' || !requested.trim()) return next();
		if (typeof ctx?.fs?.resolve !== 'function') throw new Error('记忆写入守卫无法解析路径，拒绝执行');
		const root = await getRoot();
		if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('记忆写入守卫无法解析记忆根，拒绝执行');
		const skillRoot = await getSkillRoot();
		if (typeof skillRoot !== 'string' || !path.isAbsolute(skillRoot)) throw new Error('记忆写入守卫无法解析宿主技能根，拒绝执行');
		const cwd = exec.agent === undefined ? undefined : await ctx.workingDirectory.ensure(exec.agent, exec.signal);
		const options = { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal };
		const target = await ctx.fs.resolve(requested, options);
		const rootTarget = await ctx.fs.resolve(root, { signal: exec.signal });
		const skillTarget = await ctx.fs.resolve(skillRoot, { signal: exec.signal });
		// Local fs uses realpath identities for both, including missing leaf paths.
		// Check both spellings to cover aliases in either direction.
		const candidates = [
			[rootTarget.displayPath, target.displayPath],
			[rootTarget.targetKey, target.targetKey],
		];
		if (candidates.some(([r, p]) => typeof r !== 'string' || !path.isAbsolute(r) || typeof p !== 'string' || !path.isAbsolute(p))) {
			throw new Error('记忆写入守卫无法确认路径归属，拒绝执行');
		}
		const skillCandidates = [
			[skillTarget.displayPath, target.displayPath],
			[skillTarget.targetKey, target.targetKey],
		];
		if (skillCandidates.some(([r, p]) => typeof r !== 'string' || !path.isAbsolute(r) || typeof p !== 'string' || !path.isAbsolute(p))) {
			throw new Error('记忆写入守卫无法确认技能根路径归属，拒绝执行');
		}
		const deny = (key, reason) => {
			const err = new Error(denialMessage(key, reason));
			err.name = 'MemoryWriteGuardError';
			err.code = WRITE_DENIED;
			throw err;
		};
		for (const [r, p] of candidates) {
			const verdict = classifyWrite(r, p);
			if (verdict.block) deny(verdict.key, verdict.reason);
		}
		for (const [r, p] of skillCandidates) {
			const rel = path.relative(path.resolve(r), path.resolve(p));
			if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
				deny(`skills/${rel.split(path.sep).join('/')}`, 'skill');
			}
		}
		return next();
	};
}