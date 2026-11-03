/**
 * Panel view test: drives the client half without a browser.
 *
 * No React is installable on a Host-only machine (the Web app bundles its own),
 * so this test supplies a minimal React-compatible shim: createElement plus
 * static hooks. Components are then executed once and serialized to a tiny
 * markup string, which is enough to assert the panel's information
 * architecture, per-kind folding, index tables and in-panel links.
 *
 * `props.__apiFixtures` is the documented test seam that replaces fetch, and
 * `__internalsForTest` exposes the pure parsing/folding logic.
 */
import { readFile } from 'node:fs/promises';

let failures = 0;
const ok = (cond, label) => {
	console.log(cond ? `  PASS ${label}` : `  FAIL ${label}`);
	if (!cond) failures++;
};

// --- minimal React shim -----------------------------------------------------
const FakeReact = {
	createElement(type, props, ...children) {
		const flat = children.length === 1 ? children[0] : children.length ? children : undefined;
		return { type, props: { ...(props ?? {}), children: flat } };
	},
	useState(init) {
		return [typeof init === 'function' ? init() : init, () => {}];
	},
	useEffect() {},
	useRef(value) {
		return { current: value };
	},
};

globalThis.window = { __ModuleLoader__: { load: (m) => (globalThis.__clientModule = m) } };
await import(new URL('./client.js', import.meta.url).href);
const mod = globalThis.__clientModule;
ok(Boolean(mod) && typeof mod.factory === 'function', 'client module registers a factory');
ok(mod?.id === 'dsh-memory-manager', `module id = ${mod?.id}`);

const instance = mod.factory((name) => (name === 'react' ? FakeReact : undefined));
const T = instance.__internalsForTest;

// --- slot registration ------------------------------------------------------
const registered = [];
const fakeCtx = {
	slots: {
		inject: (slot, fn) => fn(),
		register: (opts, component) => registered.push({ opts, component }),
	},
};
instance.apply(fakeCtx);
ok(registered.length === 2, `apply registers 2 slots (${registered.length})`);
ok(
	registered.some((r) => r.opts.name === 'sidebar.panellist' && r.opts.id === 'memory-panel'),
	'sidebar.panellist id = memory-panel',
);
ok(registered.some((r) => r.opts.name === 'main' && r.opts.key === 'memory-panel'), 'main panel key = memory-panel');
const MemoryPanel = registered.find((r) => r.opts.name === 'main').component;

// --- fixtures ---------------------------------------------------------------
const now = Date.now();
const iso = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
const longBlock = (n) => Array.from({ length: 8 }, (_, i) => `- 第 ${n} 块的要点 ${i + 1}：${'细节说明'.repeat(48)}`).join('\n');
const fnText = [
	'# 功能域：alpha',
	'',
	'> 当前状态摘要：alpha 已稳定，等待上线验证。',
	'',
	'## [2026-09-01] 第一次迭代',
	'',
	longBlock(1),
	'',
	'## [2026-09-20] 第二次迭代',
	'',
	longBlock(2),
	'',
	'## [2026-10-10] 第三次迭代',
	'',
	longBlock(3),
	'',
	'## [2026-10-18补] 第四次迭代',
	'',
	longBlock(4),
	'',
	'相关：[beta.md](beta.md)',
].join('\n');
const indexText = [
	'# 记忆管理（索引 + 纪律）',
	'',
	'> 读取纪律：先查索引。',
	'',
	'## 功能模块索引（functions/）',
	'',
	'| 功能域 | 一句话状态 / 待验证 |',
	'|---|---|',
	'| [alpha](functions/alpha.md) | alpha 已稳定，等待上线验证。 |',
	'| [beta](functions/beta.md) | beta 的状态摘要。 |',
	'',
	'## 创新优化思想索引（insights/）',
	'',
	'| 思想主题 | 一句话内涵 / 解决的权衡 |',
	'|---|---|',
	'| [gamma](insights/gamma.md) | gamma 的思想内涵。（来源：[alpha.md](functions/alpha.md)） |',
	'| [可观测性先于修 bug](insights/可观测性先于修 bug.md) | 带空格的主题名也必须渲染成链接。 |',
	'',
	'## 技能台账（可复用操作程序）（skills/）',
	'',
	'| 技能 | 一句话用途 | 状态 |',
	'|---|---|---|',
	'| [分离延迟重启](skills/分离延迟重启.md) | 会话跑在宿主内时用分离进程延迟杀旧起新 | active |',
	'',
	'## 决策共识 / 规范（跨功能、约束级）',
	'',
	'- 索引行摘要只说「这是什么」，不写推导过程。',
	'',
	'## 环境常量（易忘）',
	'',
	'- 记忆根：`C:/x/memory`',
	'',
	'## 细节指针（跨功能的详细论证存放处）',
	'',
	'- ',
].join('\n');
const fixtures = {
	'/api/memory-org/overview?v=0': { data: [{ root: 'C:/x/memory', initialized: true, failCount: 0, warnCount: 1, results: [{ level: 'WARN', rule: 'TEMP', message: 'functions/beta.md 冷记忆' }], title: '全局记忆', path: 'C:/x/.dsh', counts: { functions: 2, insights: 1, capabilities: 0, skills: 1, daily: 2 }, env: { version: '5.26.0', canReload: true, hotReloadRunning: false, memoryRoot: 'C:/x/memory', skillRoot: 'C:/x/.dsh/skills', indexBytes: 6000, indexComfortBytes: 8000, indexHardBytes: 16000 } }], loading: false, error: null },
	'/api/memory-org/list?zone=functions&v=0': { data: { files: [{ name: 'alpha.md', bytes: fnText.length, mtime: iso(30) }, { name: 'beta.md', bytes: 900, mtime: iso(2000) }] }, loading: false, error: null },
	'/api/memory-org/list?zone=insights&v=0': { data: { files: [{ name: 'gamma.md', bytes: 500, mtime: iso(120) }] }, loading: false, error: null },
	'/api/memory-org/list?zone=skills&v=0': { data: { files: [{ name: '分离延迟重启.md', bytes: 700, mtime: iso(60) }] }, loading: false, error: null },
	// Skill library payload — 5.20.0 storage scan: the host side lists what is
	// ON DISK (bundle dirs with their file trees); no registry fields, no
	// hostDegraded (a missing root just means no bundles there).
	// 5.24.0: ONE store — every row is a host bundle; the split is provenance
	// (agent_created ⇒ crystallized, else system), never storage.
	'/api/memory-org/skills?v=0': {
		data: {
			memory: [
				{ name: 'detached-restart', description: '会话跑在宿主内时用分离进程延迟重启', status: 'active', scope: 'global', scopeProject: '', kind: 'memory', dir: 'C:/x/.dsh/skills/detached-restart', files: [{ rel: '', name: 'SKILL.md', bytes: 4056 }, { rel: 'scripts/restart-relay.mjs', name: 'restart-relay.mjs', bytes: 5127 }] },
				{ name: 'draft-skill', description: '一个还没转正的候选', status: 'candidate', scope: 'project', scopeProject: 'demo', kind: 'memory', dir: 'C:/x/.dsh/skills/draft-skill', files: [{ rel: '', name: 'SKILL.md', bytes: 300 }] },
			],
			host: [
				{ name: 'skill-creator', description: 'Guide for creating effective skills.', source: 'user-dsh', kind: 'host', dir: 'C:/x/.dsh/skills/skill-creator', files: [{ rel: '', name: 'SKILL.md', bytes: 17957 }, { rel: 'scripts/init_skill.py', name: 'init_skill.py', bytes: 11627 }, { rel: 'scripts/quick_validate.py', name: 'quick_validate.py', bytes: 2165 }] },
			],
		},
		loading: false,
		error: null,
	},
	'/api/memory-org/skill?name=skill-creator': { data: { name: 'skill-creator', kind: 'host', text: '---\nname: skill-creator\ndescription: Guide\n---\n\n# Skill Creator\n\n先看 provider 契约。', files: [{ rel: '', name: 'SKILL.md', bytes: 60 }, { rel: 'scripts/init_skill.py', name: 'init_skill.py', bytes: 11627 }, { rel: 'scripts/quick_validate.py', name: 'quick_validate.py', bytes: 2165 }] }, loading: false, error: null },
	'/api/memory-org/skill?name=detached-restart': { data: { name: 'detached-restart', kind: 'memory', status: 'active', scope: 'global', text: '---\nname: detached-restart\nstatus: active\nagent_created: true\n---\n\n# Detached Restart\n\n## Procedure\n\n1. 锁真 PID\n2. 触发继电器', files: [{ rel: '', name: 'SKILL.md', bytes: 4056 }, { rel: 'scripts/restart-relay.mjs', name: 'restart-relay.mjs', bytes: 5127 }] }, loading: false, error: null },
	'/api/memory-org/skillfile?name=skill-creator&file=scripts%2Fquick_validate.py': { data: { name: 'skill-creator', file: 'scripts/quick_validate.py', text: '#!/usr/bin/env python3\nimport sys\n' }, loading: false, error: null },
	'/api/memory-org/skillfile?name=detached-restart&file=scripts%2Frestart-relay.mjs': { data: { name: 'detached-restart', file: 'scripts/restart-relay.mjs', text: 'import { spawn } from "node:child_process";\n' }, loading: false, error: null },
	'/api/memory-org/list?zone=daily&v=0': { data: { files: [{ name: '2026-10-18.md', bytes: 400, mtime: iso(5) }, { name: '2026-09-30.md', bytes: 800, mtime: iso(18_000) }] }, loading: false, error: null },
	'/api/memory-org/file?name=MEMORY.md&v=0': { data: { name: 'MEMORY.md', text: indexText }, loading: false, error: null },
	'/api/memory-org/file?zone=functions&name=alpha.md': { data: { name: 'alpha.md', text: fnText }, loading: false, error: null },
	'/api/memory-org/file?zone=insights&name=gamma.md': { data: { name: 'gamma.md', text: '> 性质：可重套的原则。\n\n## 核心原则\n\n- 原则本体。\n\n## 思想演进\n\n- 2026-10-18 首次沉淀。\n\n## 适用面（超出来源功能的部分）\n\n- 适用面正文。\n\n## 待观察\n\n- 待观察正文。' }, loading: false, error: null },
	'/api/memory-org/file?zone=daily&name=2026-10-18.md': { data: { name: '2026-10-18.md', text: '## 今日线索\n\n- 功能：alpha → [functions/alpha.md](functions/alpha.md)（✅ 2026-10-19 已解决 → [functions/alpha.md](functions/alpha.md)）\n\n## 今日待观察\n\n- 待验证项' }, loading: false, error: null },
	// Shapes below mirror the live API byte for byte (see the contract block in
	// api-test.mjs): overview carries `results`, search hits carry `snippet` +
	// `heading`. Fixtures that invent field names hide exactly the mismatch a user
	// sees as "the panel and the system don't agree".
	'/api/memory-org/search?q=%E5%86%B7%E8%AE%B0%E5%BF%86': { data: { hits: [{ zone: 'functions', name: 'beta.md', line: 3, heading: '今日待观察', snippet: '…冷记忆相关命中…' }] }, loading: false, error: null },
	// 收件箱（2026-10-26）：形状对齐 /inbox 路由 —— counts 三个状态 + items。
	// from 是"谁报的"，code 是问题代号，times 是重复次数（去重合并后 >1）。
	'/api/memory-org/inbox?v=0': {
		data: {
			path: 'C:/x/.dsh/storages/memory-inbox.json',
			counts: { open: 1, acknowledged: 1, resolved: 1 },
			total: 3,
			items: [
				{ fingerprint: 'aaa11111', from: 'dsh-clis', code: 'memory.R14', severity: 'warn', message: '迭代块超长未蒸馏', hint: '在写入时限制篇幅', status: 'open', times: 2, receivedAt: iso(600), lastSeenAt: iso(60) },
				{ fingerprint: 'bbb22222', from: 'agent', code: 'clis.service-missing', severity: 'error', message: '反馈服务不可用', status: 'acknowledged', times: 1, receivedAt: iso(1200), lastSeenAt: iso(300) },
				{ fingerprint: 'ccc33333', from: 'dsh-clis', code: 'memory.R3', severity: 'warn', message: '头部摘要过期', status: 'resolved', times: 1, receivedAt: iso(3000), lastSeenAt: iso(2000) },
			],
		},
		loading: false,
		error: null,
	},
};

// --- tiny renderer ----------------------------------------------------------
function serialize(node) {
	if (node === null || node === undefined || node === false || node === true) return '';
	if (typeof node === 'string') return node;
	if (typeof node === 'number') return String(node);
	if (Array.isArray(node)) return node.map(serialize).join('');
	const { type, props } = node;
	if (typeof type === 'function') {
		if (!type.name) return '';
		return serialize(type(props ?? {}));
	}
	// The component-local <style> sheet would otherwise pollute substring counts.
	if (type === 'style') return '<style/>';
	const attrs = [];
	if (props?.className) attrs.push(`class="${props.className}"`);
	if (props?.['data-dmo']) attrs.push(`data-dmo="${props['data-dmo']}"`);
	if (props?.title) attrs.push(`title="${String(props.title).slice(0, 40)}"`);
	if (props?.placeholder) attrs.push(`placeholder="${props.placeholder}"`);
	if (typeof props?.onClick === 'function') attrs.push('clickable');
	const inner = serialize(props?.children);
	return `<${type}${attrs.length ? ` ${attrs.join(' ')}` : ''}>${inner}</${type}>`;
}

const render = (initialView) => serialize(FakeReact.createElement(MemoryPanel, { __apiFixtures: fixtures, initialView }));
const count = (s, needle) => s.split(needle).length - 1;

// --- overview ---------------------------------------------------------------
const overview = render({ kind: 'overview' });
// 9 = 总览/索引/功能/思想/道/能力/技能/每日/收件箱。「道」是 5.29.6 加的：dao/ 这层
// 此前能写但没有导航项，面板里点不到——能写不能看等于半个功能。
ok(count(overview, 'data-dmo="nav-item"') === 9, `rail has 9 destinations (${count(overview, 'data-dmo="nav-item"')})`);
ok(overview.includes('功能') && overview.includes('思想') && overview.includes('每日') && overview.includes('索引') && overview.includes('能力') && overview.includes('技能') && overview.includes('道'), 'rail labels for every zone (including 道)');
ok(count(overview, 'data-dmo="growth-card"') === 5, `overview shows all five zone count cards (${count(overview, 'data-dmo="growth-card"')})`);
ok(overview.includes('能力台账') && overview.includes('技能库'), 'the added capability/skill cards label their zones');
ok(overview.includes('WARN 1') && overview.includes('冷记忆 1'), 'health chips carry the warning and the cold count');
ok(overview.includes('[WARN] TEMP: functions/beta.md 冷记忆'), 'the health list renders every problem from overview.results');
ok(overview.includes('2 功能 · 1 思想 · 0 能力 · 1 技能 · 2 日线索'), 'header summarises every zone');
// Consensus + environment constants (5.28.0): the two prose blocks of MEMORY.md
// that the index tables do not carry are surfaced on the overview.
ok(overview.includes('共识与环境常量') && overview.includes('跨功能共识 / 规范') && overview.includes('环境常量（易忘）'), 'the overview surfaces consensus and env constants');
ok(overview.includes('索引行摘要只说「这是什么」') && overview.includes('记忆根：C:/x/memory'), 'prose bullets render from MEMORY.md');
// Environment card (5.26.0): the overview answers "which build runs, where do
// the stores live, how full is the index" from the server's own truth.
ok(overview.includes('运行环境') && overview.includes('5.26.0'), 'the env card names the running version');
ok(overview.includes('支持热重启'), 'the env card reports the reload capability');
ok(overview.includes('记忆根') && overview.includes('技能库') && overview.includes('C:/x/.dsh/skills'), 'the env card names both roots');
ok(overview.includes('dmo-meter') && overview.includes('索引体积'), 'the index fill meter renders');
// The recall self-check card is on the overview: empty query explains itself.
ok(overview.includes('召回自检') && overview.includes('至少 2 个字'), 'the recall-preview card invites input');
// Hot reload (5.25.0): the header offers the in-place server-half swap button.
ok(overview.includes('热重启'), 'the header offers a 热重启 button');
ok(count(overview, 'data-dmo="timeline-row"') === 6, `timeline merges all zones (${count(overview, 'data-dmo="timeline-row"')})`);
const tl = overview.slice(overview.indexOf('data-dmo="timeline-row"'));
ok(tl.indexOf('2026-10-18') < tl.indexOf('beta'), 'timeline is newest-first');
ok(overview.includes('alpha 已稳定'), 'timeline rows carry the index one-line summary');
ok(overview.includes('刚刚') || overview.includes('分钟前'), 'timeline shows relative time');
// overview usage card: fixtures have no usage field -> the empty state explains
// where signals come from instead of rendering a broken chart
ok(overview.includes('还没有使用信号'), 'usage card explains itself when there are no signals');
ok(count(overview, 'dmo-card') >= 3, `overview renders health + usage + timeline cards (${count(overview, 'dmo-card')})`);
// with usage data, the layer histogram + hotspots render
const overviewWithUsage = serialize(
	FakeReact.createElement(MemoryPanel, {
		__apiFixtures: {
			...fixtures,
			'/api/memory-org/overview?v=0': { data: [{ root: 'C:/x/memory', initialized: true, failCount: 0, warnCount: 1, results: [{ level: 'WARN', rule: 'TEMP', message: 'functions/beta.md 冷记忆' }], counts: { functions: 2, insights: 1, capabilities: 0, skills: 1, daily: 2 }, usage: { signalCount: 12, layers: { 实验: 2, 专项: 1, 通用: 0 }, hotspots: [{ href: 'functions/beta.md', flips: 2, badRate: 0.5, uses: 3 }] } }], loading: false, error: null },
		},
		initialView: { kind: 'overview' },
	}),
);
ok(overviewWithUsage.includes('实验 2') && overviewWithUsage.includes('专项 1'), 'usage card renders the layer histogram');
ok(overviewWithUsage.includes('30 天 12 条信号'), 'usage card shows the signal count');
ok(overviewWithUsage.includes('结论反复推翻（翻转 2）'), 'hotspots name flip-heavy memories');
ok(overviewWithUsage.includes('纠正率 50%'), 'hotspots name high correction rates');

// --- zone list --------------------------------------------------------------
const funList = render({ kind: 'zone', zone: 'functions' });
ok(count(funList, 'data-dmo="row"') === 2, 'functions list renders one row per file');
ok(funList.includes('alpha 已稳定，等待上线验证。'), 'list rows show the index summary (no need to open the file)');
ok(funList.includes('按时间 ↓') && funList.includes('切换排序'), 'sort toggle offered for named zones');
ok(funList.includes('按名称或摘要过滤'), 'filter input offered');
ok(funList.indexOf('alpha') < funList.indexOf('beta'), 'newest file first by default');
const dailyList = render({ kind: 'zone', zone: 'daily' });
ok(dailyList.includes('2026-10-18') && !dailyList.includes('按名称'), 'daily zone lists dates, no name sort');
ok(count(dailyList, 'class="dmo-month"') === 2, `daily zone groups days by month (${count(dailyList, 'class="dmo-month"')})`);
ok(dailyList.indexOf('2026-10') < dailyList.indexOf('2026-09'), 'months run newest-first');

// --- skill library: one destination, two sides behind a toggle ---------------
// The tab is NAVIGATION state (view.tab), so each side renders deterministically
// without a live useState — exactly why the panel test can assert both halves.
// 5.20.0: the payload is a STORAGE scan — rows carry their file lists, the
// detail view renders SKILL.md plus a clickable file tree (scripts/...).
const skillMem = render({ kind: 'zone', zone: 'skills', tab: 'memory' });
ok(count(skillMem, 'data-dmo="skill-tab"') === 2, 'the library offers two toggle tabs');
ok(skillMem.includes('结晶技能 2') && skillMem.includes('系统技能 1'), 'tabs carry per-side counts');
ok(skillMem.includes('detached-restart') && skillMem.includes('draft-skill'), 'crystallized tab lists every lifecycle state');
// 5.24.0: active IS published (one store, one lifecycle) — the redundant
// "已发布宿主" badge is gone, the status chip carries it.
ok(!skillMem.includes('已发布宿主'), 'no redundant publish badge beside the status chip');
ok(skillMem.includes('active') && skillMem.includes('candidate'), 'lifecycle statuses render');
ok(skillMem.includes('global') && skillMem.includes('project:demo'), 'scope renders, project keeps its key');
ok(!skillMem.includes('skill-creator'), 'the crystallized tab does not leak system rows');
const skillHost = render({ kind: 'zone', zone: 'skills', tab: 'host' });
ok(skillHost.includes('skill-creator') && skillHost.includes('user-dsh'), 'system tab lists stored bundles with their root source');
ok(skillHost.includes('3 文件'), 'a bundle row shows its stored file count');
ok(!skillHost.includes('detached-restart'), 'the system tab does not leak crystallized rows');
ok(count(skillHost, 'data-dmo="skill-row"') === 1, `system tab rows == payload length (${count(skillHost, 'data-dmo="skill-row"')})`);
// ONE renderer for ONE store: a detail view is a bundle from either tab —
// SKILL.md + clickable file tree, navigation identical.
const hostRead = render({ kind: 'bundle', name: 'skill-creator', tab: 'host' });
ok(hostRead.includes('先看 provider 契约') && hostRead.includes('存储内容 · 只读'), 'the stored SKILL.md renders, read-only');
ok(hostRead.includes('文件 3') && hostRead.includes('scripts/init_skill.py') && hostRead.includes('scripts/quick_validate.py'), 'the bundle file tree is listed (SKILL.md + scripts)');
const hostFile = render({ kind: 'bundle', name: 'skill-creator', tab: 'host', file: 'scripts/quick_validate.py' });
ok(hostFile.includes('#!/usr/bin/env python3'), 'a stored resource file renders its raw text');
ok(hostFile.includes('scripts/quick_validate.py'), 'the file view titles the selected resource');
// Lifecycle controls on the crystallized side (5.21.0): an enable switch per
// row (state reflects the lifecycle) and a delete button — the host side has
// none (bundles are managed in their own repos).
ok(count(skillMem, 'data-dmo="skill-toggle"') === 2, 'every crystallized row carries an enable switch');
// The shim's serializer does not carry aria-*, so switch state is asserted via
// the class the renderer derives it from: exactly one switch is ON (active),
// the other stays default (candidate).
ok(count(skillMem, 'dmo-switch on') === 1, 'exactly one switch renders ON (the active skill)');
ok(count(skillMem, 'title="停用（retire）"') === 1 && count(skillMem, 'title="启用（activate）"') === 1, 'switch titles reflect each row\'s lifecycle');
ok(count(skillMem, 'data-dmo="skill-delete"') === 2, 'every crystallized row carries a delete button');
ok(count(skillHost, 'data-dmo="skill-toggle"') === 0 && count(skillHost, 'data-dmo="skill-delete"') === 0, 'system rows carry no lifecycle controls');
// ONE renderer for ONE store: opening a bundle from either tab gives the same
// view — SKILL.md body, clickable file tree, and the way back lands the reader
// where they came from (view.tab), which only holds if the views are the same.
const memRead = render({ kind: 'bundle', name: 'detached-restart', tab: 'memory' });
ok(memRead.includes('锁真 PID') && memRead.includes('存储内容 · 只读'), 'the crystallized detail renders its stored bundle body');
ok(memRead.includes('文件 2') && memRead.includes('scripts/restart-relay.mjs'), 'the crystallized detail lists its own bundle file tree');
// The merge's payoff: a crystallized skill gets the SAME resource browser the
// system side always had — click scripts/restart-relay.mjs, read its source.
const memFile = render({ kind: 'bundle', name: 'detached-restart', tab: 'memory', file: 'scripts/restart-relay.mjs' });
ok(memFile.includes('import { spawn } from "node:child_process"'), 'a crystallized bundle opens its script through /skillfile too');
ok(hostRead.includes('返回技能库'), 'the detail view offers the way back');

// --- markdown preview mode: code blocks and tables are READER-grade ----------
// A fenced block renders as a framed unit: language badge, copy button, and a
// pre that keeps its own scroll (a long line never stretches the panel). The
// index fixture carries no fence, so build the view from a body that does.
const mdProbe = serialize(FakeReact.createElement(T.SearchPane, {
	res: { data: { hits: [] }, loading: false, error: null },
	q: 'x', zone: 'all', setZone: () => {}, onOpen() {},
}));
ok(mdProbe.includes('这个分区没有命中') || mdProbe.includes('搜索'), 'search probe renders');
const codeFixture = {
	'/api/memory-org/file?zone=functions&name=alpha.md': {
		data: {
			name: 'alpha.md',
			text: [
				'# 功能域：alpha',
				'',
				'> 当前状态摘要：预览断言。',
				'',
				'## [2026-10-01] 带代码与表格的块',
				'',
				'```js',
				'const x = 1;',
				'```',
				'',
				'| 列一 | 列二 |',
				'|---|---|',
				'| a | b |',
				'| c | d |',
			].join('\n'),
		},
		loading: false,
		error: null,
	},
};
const mdView = serialize(FakeReact.createElement(MemoryPanel, {
	__apiFixtures: { ...fixtures, ...codeFixture },
	initialView: { kind: 'file', zone: 'functions', name: 'alpha.md' },
}));
ok(count(mdView, 'class="dmo-code"') === 1, 'a fenced block renders as one framed code unit');
ok(mdView.includes('dmo-code-lang') && mdView.includes('js'), 'the language badge shows the fence tag');
ok(count(mdView, 'data-dmo="code-copy"') === 1, 'the code block carries a copy button');
ok(mdView.includes('const') && mdView.includes('x = ') && mdView.includes('1'), 'the code body renders');
// Coloring (5.29.0): a known-language fence becomes token spans; the raw text
// must survive the split intact (concatenation equals the source, no loss).
ok(mdView.includes('dmo-t-kw') && mdView.includes('>const<'), 'js keyword renders as a colored span');
ok(mdView.replace(/<[^>]+>/g, '').includes('const x = 1;'), 'token spans concatenate back to the exact source');
// Tokenizer edge guards: the judgment calls that a naive highlighter gets wrong.
const T_classes = (text, lang) => T.tokenizeCode(text, lang).filter(([c]) => c);
ok(!T_classes('---\ny: 1\n# n', 'yaml').some(([c]) => c.startsWith('diff')), 'yaml doc marker never reads as a diff');
ok(!T_classes('let x = u32', 'rust').some(([c, v]) => c === 'num' && v.includes('32')), 'identifier u32 is not half a number');
ok(T_classes('echo "abc', 'sh').every(([c]) => c !== 'str'), 'unterminated string stays plain');
ok(T_classes('just prose', '').length === 0, 'unknown language is never colored');
ok(T.tokenizeCode('const s = "x" // c', 'js').map(([, v]) => v).join('') === 'const s = "x" // c', 'tokens rejoin losslessly');
ok(count(mdView, 'dmo-table-wrap') === 1, 'a table renders inside its own scroll box');
ok(count(mdView, 'class="dmo-table"') === 1 && mdView.includes('列一') && mdView.includes('列二'), 'the table keeps its header cells');
ok(mdView.includes('odd'), 'zebra striping marks alternate rows');
// Heading levels 1-4 must ALL render as elements, never as literal hashes: a
// body whose sections are `## `-style printed raw markdown until this level
// range was covered (found on the real page, hence the `## ` body here).
const hFixture = {
	'/api/memory-org/file?zone=functions&name=alpha.md': {
		data: { name: 'alpha.md', text: '## 程序体（唯一来源）\n\n正文行。\n\n### 三级\n\n#### 四级\n' },
		loading: false,
		error: null,
	},
};
const hView = serialize(FakeReact.createElement(MemoryPanel, {
	__apiFixtures: { ...fixtures, ...hFixture },
	initialView: { kind: 'file', zone: 'functions', name: 'alpha.md' },
}));
ok(hView.includes('程序体（唯一来源）') && !hView.includes('## 程序体'), 'a ## heading renders as an element, not literal hashes');
ok(hView.includes('三级') && !hView.includes('### 三级'), 'a ### heading renders as an element');
ok(hView.includes('四级') && !hView.includes('#### 四级'), 'a #### heading renders as an element');

// --- reader: long function file folds to the newest block -------------------
// Sections render newest-first (the file is append-only oldest-first; the
// reader flips the order so the top card is always the latest state).
const fnRead = render({ kind: 'file', zone: 'functions', name: 'alpha.md' });
ok(count(fnRead, 'data-dmo="section"') === 4, `function file shows 4 iteration blocks (${count(fnRead, 'data-dmo="section"')})`);
ok(count(fnRead, 'dmo-sec-body') === 1, 'only the newest block is expanded by default');
ok(fnRead.indexOf('第四次迭代') < fnRead.indexOf('第一次迭代'), 'blocks render newest-first');
ok(count(fnRead, 'data-dmo="toc-chip"') === 4, 'jump strip lists every block');
ok(fnRead.indexOf('2026-10-18') < fnRead.indexOf('2026-09-01'), 'jump strip is newest-first');
ok(fnRead.includes('当前状态摘要'), 'head summary stays visible above the blocks');
ok(fnRead.includes('返回') && fnRead.includes('展开全部') && fnRead.includes('复制路径'), 'reader toolbar complete');
ok(count(fnRead, 'clickable') > 4, 'rows and chips are interactive');

// --- reader: index renders navigation tables instead of raw text ------------
const idxRead = render({ kind: 'file', zone: '', name: null });
ok(count(idxRead, 'dmo-idx-row') === 4, `index renders 4 clickable navigation rows (${count(idxRead, 'dmo-idx-row')})`);
ok(idxRead.includes('alpha 已稳定') && idxRead.includes('gamma 的思想内涵'), 'both index tables render');
// A theme slug with a space (「可观测性先于修 bug」) is a legal filename: its
// link must render as a button, not degrade to raw `[text](href)` text —
// the old [^)\s] href pattern made the path appear twice and read as a dupe.
ok(idxRead.includes('带空格的主题名也必须渲染成链接。'), 'spaced theme row renders its summary');
ok(count(idxRead, 'title="insights/可观测性先于修 bug.md"') >= 1, 'spaced theme link renders as a button (not raw markdown)');
ok(!/\[insights\/[^\]]*\]\(insights\//.test(idxRead), 'no raw markdown link survives inside the index tables');
ok(count(idxRead, 'data-dmo="section"') === 0, 'index tables are not duplicated as section cards');
// Consensus and env-constant bullets now live on the overview card; the index
// page must NOT repeat them (5.28.0). The detail-pointer block is overview-free
// and stays on the index.
ok(!idxRead.includes('记忆根：') && !idxRead.includes('索引行摘要只说'), 'index does not repeat consensus/env constants shown on the overview');
ok(idxRead.includes('细节指针'), 'the detail-pointer section still renders on the index');
ok(idxRead.includes('clickable'), 'index rows open their target file in-panel');

// --- sub-tables: a zone section split by `### 索引·<域>` ----------------------
// Once a zone grows past ~40 rows the server writes `### 索引·<域>` sub-tables
// (R5 nags until it does), each with its OWN header row. Rendering the whole
// `##` section as one table therefore printed the column header twice and glued
// two tables together — the real duplication the panel showed for 功能域 and
// 思想主题. One sub-table per `###`, one header each.
const groupedSection = {
	heading: '功能模块索引（functions/）',
	body: [
		'| 功能域 | 一句话状态 |', '|---|---|',
		'| [甲](functions/甲.md) | 主表行 |',
		'', '### 索引·业务功能', '',
		'| 功能域 | 一句话状态 |', '|---|---|',
		'| [乙](functions/乙.md) | 分组行 |',
	].join('\n'),
};
const grouped = T.subTablesOf(groupedSection);
ok(grouped.length === 2, `a grouped section yields one table per sub-heading (${grouped.length})`);
ok(grouped[0].title === '功能模块索引（functions/）' && grouped[1].title === '功能模块索引（functions/） · 业务功能', `each sub-table carries a distinct title (${grouped.map((t) => t.title).join(' / ')})`);
ok(grouped.every((t) => t.rows[0][0] === '功能域'), 'each sub-table keeps its own header row');
ok(grouped.reduce((n, t) => n + t.rows.length - 1, 0) === 2, 'data rows are split across sub-tables, not concatenated');
// A heading containing a space keeps its whole name: the old
// `replace(/^[^ ]*\s*/, '')` ate "能力台账 " and titled the table "细节子目录（…）".
const capSection = {
	heading: '能力台账 细节子目录（可用工具 / MCP / CLI）',
	body: ['| 能力 | 一句话用途 |', '|---|---|', '| [x](capabilities/x.md) | 用途 |'].join('\n'),
};
ok(T.subTablesOf(capSection)[0].title === '能力台账 细节子目录（可用工具 / MCP / CLI）', 'a spaced heading keeps its leading name');
// An empty section (the dao list is bullets, not a table) renders no table at
// all, instead of a headerless empty grid.
ok(T.subTablesOf({ heading: '道层（最抽象的指导思想）', body: '- 一条\n- 两条' }).length === 0, 'a bullet-only section yields no table');

// --- heading COLLISION: 道层（最抽象的指导思想）contains 「思想」 ---------------
// The panel used `includes('思想')` to pick the insight section, so the dao
// section — whose title literally contains 思想 — was parsed as insights and its
// rows were silently dropped (no error, just an empty zone list). Substring
// keyword matching breaks the moment two headings share a word; the fix is an
// ordered exact-prefix table.
const collisionIndex = [
	'## 道层（最抽象的指导思想）', '',
	'- **静默失效** — 失败多数不是做错了，而是做不成却不告诉你（[正文](dao/静默失效.md)）', '',
	'## 创新优化思想索引（insights/）', '',
	'| 思想主题 | 一句话内涵 |', '|---|---|',
	'| [某思想](insights/某思想.md) | 内涵 |', '',
].join('\n');
const ct = T.parseIndexTables(collisionIndex);
ok(Object.keys(ct.dao).length === 1 && ct.dao['静默失效'], `道层 is parsed as dao, not insights (dao=${Object.keys(ct.dao).join(',')})`);
ok(ct.dao['静默失效'].href === 'dao/静默失效.md', 'a dao bullet keeps its target href');
ok(ct.insights['某思想']?.summary === '内涵' && Object.keys(ct.insights).length === 1, `insight rows stay in insights (${Object.keys(ct.insights).join(',')})`);
// defaultOpen must also treat the dao section as an index section (it contains
// 思想, so the old substring rule matched it as an insight index — harmless there
// but a sign the same bug class was copied around).
{
	const secs = [{ heading: '道层（最抽象的指导思想）' }, { heading: '细节指针' }];
	const open = T.defaultOpen('index', secs, 'x'.repeat(5000));
	ok(open[0] === true, 'the dao section starts expanded on the index page');
	ok(open[1] === false, 'a non-index section stays collapsed');
}

// --- reader: insight + daily open every section ----------------------------
const insRead = render({ kind: 'file', zone: 'insights', name: 'gamma.md' });
ok(count(insRead, 'data-dmo="section"') === 4 && count(insRead, 'dmo-sec-body') === 4, 'insight sections all open (short file)');
ok(insRead.includes('核心原则') && insRead.includes('适用面'), 'insight section titles render');
const dayRead = render({ kind: 'file', zone: 'daily', name: '2026-10-18.md' });
ok(dayRead.includes('今日线索') && dayRead.includes('今日待观察'), 'daily threads render their sections');
ok(dayRead.includes('clickable'), 'daily bullet links navigate in-panel');
// The ✅ resolution stamp collapses into one compact chip (not a second inline
// pointer), and a repeated pointer to the same target degrades to plain text.
ok(count(dayRead, 'dmo-resolve') === 1, `resolution stamp renders as one chip (${count(dayRead, 'dmo-resolve')})`);
ok(!dayRead.includes('（✅ 2026-10-19 已解决 →'), 'raw stamp text is gone');
const raiseIdx = dayRead.indexOf('功能：alpha');
const dupIdx = dayRead.indexOf('功能：alpha', raiseIdx + 1);
ok(raiseIdx !== -1, 'raise-site link present');
const linkBtns = dayRead.split('class="dmo-link"').length - 1;
ok(linkBtns === 1, `alpha is a clickable link exactly once in the row (buttons=${linkBtns}, secondTextIdx=${dupIdx})`);
// Daily bullet lines flip to newest-first inside the reader (the file is an
// append-only audit trail; the latest situation must sit on top). The fixture
// body has alpha's bullet before 待观察's; after the flip 待观察 must come first.
const dayBody = dayRead.slice(dayRead.indexOf('今日线索'));
ok(dayBody.indexOf('待验证项') < dayBody.lastIndexOf('alpha'), `daily bullets render newest-first (${dayBody.indexOf('待验证项')} < ${dayBody.lastIndexOf('alpha')})`);
ok(dayBody.indexOf('今日待观察') < dayBody.lastIndexOf('功能：alpha'), 'daily section order unchanged, only bullet order flips');

// --- recall self-check card (5.26.0) -----------------------------------------
// The card shows what the REAL pre-step pipeline would inject for a query.
// Rows carry reasons; a file:/// skill row opens the bundle view, not a reader.
const previewRes = {
	data: {
		query: '重启 宿主',
		tokens: ['重启', '宿主'],
		usageSignals: 3,
		rows: [
			{ href: 'file:///C:/x/.dsh/skills/detached-restart/SKILL.md', zone: 'skill', summary: '会话跑在宿主内时用分离继电器安全重启', fusedScore: 2.9, reasons: ['名称命中：重启', '使用 6 次 · 认可 2 · 纠正率 0'] },
			{ href: 'functions/memory-manager.md', zone: 'function', summary: '记忆插件 5.26.0', fusedScore: 1.2, lexicalScore: 1.2, reasons: ['词法分 1.20'] },
		],
		message: '',
	},
	loading: false,
	error: null,
};
const previewView = serialize(
	FakeReact.createElement(T.RecallPreviewCard, { res: previewRes, q: '重启 宿主', setQ: () => {}, onNavigate: () => {} }),
);
ok(count(previewView, 'data-dmo="preview-row"') === 2, `every recalled row renders (${count(previewView, 'data-dmo="preview-row"')})`);
ok(previewView.includes('detached-restart') && previewView.includes('得分 2.9'), 'a bundle row labels itself by its DIRECTORY name, with its score');
ok(previewView.includes('名称命中') && previewView.includes('使用 6 次'), 'the reasons behind each recall land as chips');
ok(previewView.includes('技能') || previewView.includes('功能'), 'rows carry their zone tags');
const previewEmpty = serialize(
	FakeReact.createElement(T.RecallPreviewCard, { res: { data: { query: 'zz', rows: [], message: '（无命中：该输入不会注入任何召回）' }, loading: false, error: null }, q: 'zz', setQ: () => {}, onNavigate: () => {} }),
);
ok(previewEmpty.includes('无命中'), 'an empty recall explains itself instead of showing a blank card');
const previewIdle = serialize(
	FakeReact.createElement(T.RecallPreviewCard, { res: { data: null, loading: false, error: null }, q: '', setQ: () => {}, onNavigate: () => {} }),
);
ok(previewIdle.includes('至少 2 个字'), 'an idle preview invites input');

// --- search results use the API's snippet + heading --------------------------
let searchZoneCalls = 0;
const searchView = serialize(
	FakeReact.createElement(T.SearchPane, {
		res: fixtures['/api/memory-org/search?q=%E5%86%B7%E8%AE%B0%E5%BF%86'],
		q: '冷记忆',
		zone: 'all',
		setZone: () => searchZoneCalls++,
		onOpen() {},
	}),
);
ok(searchView.includes('相关命中'), 'search hits render the API snippet text');
ok(searchView.includes('dmo-mark') && searchView.includes('冷记忆'), 'the query is highlighted inside the snippet');
ok(searchView.includes('今日待观察'), 'search hits show their section heading');
ok(searchView.includes('第 3 行'), 'search hits show the line number');
ok(count(searchView, 'data-dmo="search-zone"') === 7, `search offers a zone filter (${count(searchView, 'data-dmo="search-zone"')} chips)`);
ok(searchView.includes('技能'), 'the search zone chips include the skills zone');
ok(searchView.includes('dmo-chip btn active'), 'the active zone chip is marked');
// a filtered empty result explains itself instead of looking broken
const emptyFiltered = serialize(
	FakeReact.createElement(T.SearchPane, {
		res: { data: { hits: [] }, loading: false, error: null },
		q: '冷记忆',
		zone: 'insights',
		setZone: () => {},
		onOpen() {},
	}),
);
ok(emptyFiltered.includes('这个分区没有命中'), 'empty zone-filtered result explains the filter');
// highlight() splits the text around the match and marks it
const hl = T.highlight('abc冷记忆def', '冷记忆');
ok(hl.length === 3 && hl[0] === 'abc' && hl[1]?.type === 'mark' && hl[1].props.children === '冷记忆' && hl[2] === 'def', 'highlight marks the matched span');
const noQ = T.highlight('纯文本', '');
ok(noQ.length === 1 && noQ[0] === '纯文本', 'highlight is a no-op without a query');

// --- 问题收件箱（2026-10-26）-------------------------------------------------
// 用户要求能在面板里自己掌控全局：看到有哪些问题、谁报的、修了没，
// 并且能把状态从 open 推到 acknowledged/resolved。
const inboxView = render({ kind: 'inbox' });
const inboxRows = count(inboxView, 'data-dmo="inbox-row"');
ok(inboxRows === 3, `inbox renders every tracked item (${inboxRows})`);
ok(inboxView.includes('memory.R14') && inboxView.includes('memory.R3'), 'inbox shows the problem codes');
ok(inboxView.includes('dsh-clis') && inboxView.includes('agent'), 'inbox shows who reported each item');
// 计数徽标：三个状态各 1 条，用户一眼看到分布
ok(inboxView.includes('未处理 1') && inboxView.includes('处理中 1') && inboxView.includes('已解决 1'), 'inbox chips carry per-status counts');
// 重复次数可见：同一问题反复投递时不该被当成新问题
ok(inboxView.includes('重复 2 次'), 'inbox surfaces how many times a problem recurred');
// 方向提示要显示 —— 这是"该怎么看"而不只是"有问题"
ok(inboxView.includes('在写入时限制篇幅'), 'inbox surfaces the hint');
// 状态操作按钮：open 可认领+解决，acknowledged 可解决，resolved 可重开
ok(inboxView.includes('认领') && inboxView.includes('标记已解决') && inboxView.includes('重新打开'), 'inbox offers status transitions');
const inboxFilters = count(inboxView, 'data-dmo="inbox-filter"');
ok(inboxFilters === 3, `inbox offers one filter per status (${inboxFilters})`);

// 删除（2026-10-26）：与"标记已解决"是两回事 —— 解决保留记录，删除抹掉记录。
// 渲染是一次性的（无交互），故这里只钉"删除入口存在且默认不在确认态"；
// 真正的删除行为由 api-test 走 HTTP 路由验证。
const inboxDeletes = count(inboxView, 'data-dmo="inbox-delete"');
ok(inboxDeletes === 3, `every inbox row offers a delete button (${inboxDeletes})`);
ok(inboxView.includes('>删除<'), 'the delete button is labelled 删除');
ok(!inboxView.includes('确认删除'), 'delete is not in the confirm state until clicked (destructive needs two steps)');
ok(!inboxView.includes('删除后无法恢复'), 'the irreversible warning stays hidden until the user asks to delete');

// 侧边栏数值：收件箱的徽标取**未处理**数（fixture 里 open=1），
// 且它来自 /inbox 接口而不是 zone 计数 —— 早先 counts[n.key] 拿不到它，徽标恒不显示。
ok(count(overview, 'data-dmo="nav-count-inbox"') === 1, 'the rail shows a count badge on the inbox entry');
ok(overview.includes('data-dmo="nav-count-inbox">1<'), 'the inbox badge carries the open count (1)');
// 已解决的不该让徽标一直亮着：fixture 里 acknowledged=1 / resolved=1 都不计入。
ok(!overview.includes('data-dmo="nav-count-inbox">3<'), 'the badge counts only unhandled items, not all of them');

// 导航接线（2026-10-26 真 bug）：早期 click 处理器只认 overview/index，
// 其余一律 setView({kind:'zone'}) —— 点「收件箱」会落到 zone 分支渲染空白。
// 这里钉住 rail 确实带收件箱项且标签正确，防止再被塞回 zone 分支。
// 数量 9 = 8 个分区 + 收件箱；新增分区时这里要同步（断言会提醒）。
ok(count(overview, 'data-dmo="nav-item"') === 9, `rail renders 9 items so the inbox entry exists`);
ok(overview.includes('收件箱'), 'the rail labels the inbox entry');

// --- pure logic -------------------------------------------------------------
const tables = T.parseIndexTables(indexText);
ok(tables.functions.alpha?.summary === 'alpha 已稳定，等待上线验证。', 'parseIndexTables maps slug -> summary');
ok(tables.insights.gamma?.href === 'insights/gamma.md', 'parseIndexTables keeps the target href');
// 5.15.0 dropped the link column, so a row is now name+summary (2 cells) — the
// nav panel must not skip those (the old 3-cell floor silently dropped them).
const mixed = [
	'## 功能模块索引（functions/）',
	'',
	'| 功能域 | 一句话状态 / 待验证 |',
	'|---|---|',
	'| [新版行](functions/新版行.md) | 两列的当前形态。 |',
	'| 旧版行 | 四列的历史形态。 | [functions/旧版行.md](functions/旧版行.md) |',
].join('\n');
const mixedTables = T.parseIndexTables(mixed);
ok(mixedTables.functions['新版行']?.summary === '两列的当前形态。' && mixedTables.functions['新版行']?.href === 'functions/新版行.md', 'parseIndexTables reads 2-column rows');
ok(mixedTables.functions['旧版行']?.href === 'functions/旧版行.md', 'parseIndexTables still reads legacy 4-column rows');
ok(T.parseIndexTables('| [孤儿](functions/孤儿.md) | 没有标题的行 |').functions['孤儿'] === undefined, 'rows outside a table heading are ignored');
const split = T.splitSections(fnText);
ok(split.sections.length === 4 && split.sections[3].date === '2026-10-18', 'splitSections extracts dated blocks');
ok(split.preamble.includes('当前状态摘要'), 'splitSections keeps the head summary as preamble');
ok(T.defaultOpen('functions', split.sections, fnText)[0] === true && T.defaultOpen('functions', split.sections, fnText)[3] === false, 'fold policy opens the newest block only (reversed order: index 0 is newest)');
ok(T.defaultOpen('insights', split.sections, 'short')[0] === true, 'fold policy opens everything in short files');
const idxSections = T.splitSections(indexText).sections;
// With the skills table added, sections are: 功能 / 思想 / 技能 / 环境常量 / 细节指针 —
// the three tables open, the prose sections fold.
const idxOpen = T.defaultOpen('index', idxSections, indexText);
ok(idxOpen[0] === true && idxOpen[2] === true && idxOpen[3] === false, 'index opens the tables and folds the rest');
ok(T.resolveHref('../functions/alpha.md', 'insights')?.zone === 'functions', 'insight backlinks resolve to functions');
ok(T.resolveHref('insights/gamma.md', 'functions')?.zone === 'insights', 'insights hrefs resolve');
ok(T.resolveHref('2026-10-18.md', 'daily')?.zone === 'daily', 'daily hrefs resolve');
ok(T.resolveHref('MEMORY.md', 'functions')?.zone === '', 'MEMORY.md resolves to the index');
ok(T.resolveHref('beta.md', 'functions')?.zone === 'functions', 'bare sibling links stay in their zone');
ok(T.resolveHref('https://example.com', 'functions') === null, 'external links are not treated as memory files');
ok(T.plain('[x.md](x.md) **状态**') === 'x.md 状态', 'plain() strips markdown for summaries');
ok(T.relTime(new Date(Date.now() - 3600_000).toISOString()) === '1 小时前', 'relTime renders hours');

console.log(failures === 0 ? 'UI ALL PASS' : `${failures} UI FAILURES`);
process.exit(failures === 0 ? 0 : 1);