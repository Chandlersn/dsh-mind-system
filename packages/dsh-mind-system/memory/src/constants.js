/**
 * Shared constants: tool identity, size/temperature defaults, and every
 * canonical table heading + header row the index and the tools agree on.
 */

export const name = 'memory-manager';
export const inject = ['tools', 'systemPrompt', 'webServer'];

export const DEFAULTS = {
	maxIndexBytes: 10 * 1024, // 索引舒适线
	maxIndexHardBytes: 15 * 1024, // 索引硬上限（达到即拒绝写入）
	maxFunctionBytes: 30 * 1024, // 单个功能文件上限
	newFeatureGraceDays: 3, // TEMP 冷记忆宽限期：最近改动过的不报冷
	// Foreground recall budget (MemOS borrow ⑤): config may shorten it, never
	// extend past this ceiling; a timeout injects nothing rather than a stale or
	// partial recall.
	recallTimeoutMs: 3000,
	// Passive capture of user turns into the RAW daily layer (MemOS borrow ⑥).
	// OFF by default: the raw layer belongs to the model, and logging every turn
	// is noise (and a privacy question). Captured lines are truncated.
	captureUserTurns: false,
	captureMaxChars: 160,
};

// Index tables — one row per entry with TWO columns: a clickable name and its
// one-line summary. The old separate "过程链接 / 思想内容 / 台账" column was pure
// noise (the name cell now carries the link) and 4 columns ate the horizontal
// space the summaries needed. The skills table keeps a third column because
// RECALL trusts that cell (only active skills are injected).
export const FUNC_TABLE_HEADING = '## 功能模块索引';
export const INSIGHT_TABLE_HEADING = '## 创新优化思想索引';
// The capability heading: base `## 能力台账 细节子目录` is the upsert anchor
// (matched by startsWith, like the other zones) and the template appends
// `（可用工具 / MCP / CLI）`. Before 5.15.2 the tool list sat INSIDE the anchor
// and the fallback path stacked a second paren after it, reading as a
// duplicated qualifier: `…（可用工具 / MCP / CLI）（细节在子目录）`.
export const CAP_TABLE_HEADING = '## 能力台账 细节子目录';
// The tool-list suffix the template and the heading migration both append.
export const CAP_TABLE_SUFFIX = '（可用工具 / MCP / CLI）';
// Pre-5.15.2 capability heading anchor, kept only so upsertIndexRow can find
// and rename an old-generation heading in place instead of twin-ing it.
export const LEGACY_CAP_TABLE_HEADING = '## 能力台账（可用工具 / MCP / CLI）';
export const CAP_TABLE_HEADER = '| 能力 | 一句话用途 |';
export const FUNC_TABLE_HEADER = '| 功能域 | 一句话状态 / 待验证 |';
export const INSIGHT_TABLE_HEADER = '| 思想主题 | 一句话内涵 / 解决的权衡 |';

// The pre-5.15.0 four-column headers, kept only so a half-migrated index is
// recognized instead of counted as content (R15 exemption + lint skips). Never
// written again — new rows always use the 2/3-column shape above.
export const LEGACY_FUNC_TABLE_HEADER = '| 功能域摘要 | 一句话状态 / 待验证 | 过程链接 | 摘要 |';
export const LEGACY_INSIGHT_TABLE_HEADER = '| 思想主题 | 一句话内涵 / 解决的权衡 | 思想内容 | 相关（来源功能） |';
export const LEGACY_CAP_TABLE_HEADER = '| 能力 | 一句话用途 | 台账 | 类型 |';
export const LEGACY_SKILL_TABLE_HEADER = '| 技能 | 一句话用途 | 台账 | 状态 |';
export const LEGACY_TABLE_HEADERS = new Set([LEGACY_FUNC_TABLE_HEADER, LEGACY_INSIGHT_TABLE_HEADER, LEGACY_CAP_TABLE_HEADER, LEGACY_SKILL_TABLE_HEADER]);

// Insight trust (Hindsight's observations idea, adapted): a principle is a
// BELIEF and beliefs carry evidence. The evidence already exists — positive /
// correction signals in .usage.jsonl — so trust is COMPUTED from them, never
// declared by hand. 待验证 (no verdict yet) → 已验证 → 稳固; 动摇 (corrections
// reached or passed the positives) is the refine/supersede prompt.
export const TRUST_LEVELS = ['待验证', '已验证', '稳固', '动摇'];

// skills — the crystallization layer. Statuses mirror MemOS's lifecycle:
// candidate → active (verified) → retired (environment changed; kept as history).
export const SKILL_DIR = 'skills';
export const SKILL_STATUSES = ['candidate', 'active', 'retired'];
export const SKILL_TABLE_HEADING = '## 技能台账（可复用操作程序）';
export const SKILL_TABLE_HEADER = '| 技能 | 一句话用途 | 状态 |';
// Nomination thresholds (the mechanical half of MemOS's support/gain floors,
// fed by .usage.jsonl): an area earns a look when it has been USED repeatedly,
// CONFIRMED at least once, and is not mostly corrections.
export const SKILL_NOMINATE = { minUses: 6, minPositives: 1, maxBadRate: 0.2 };

export const CAP_DIR = 'capabilities';

// ---------------------------------------------------------------------------
// THE zone list — single source of truth (2026-10-28)
// ---------------------------------------------------------------------------
// Before this, the same set of directory names was written out in ~20 places
// (six literal arrays, six regexes, the client's three keyword regexes, two
// enums, the panel's zone whitelist…). Adding `dao/` therefore did NOT add it:
// every reader kept its own stale copy, so the fourth memory layer was writable
// but invisible — no count, no listing, no search, no memory_read, and the
// usage ledger rejected its hrefs. A layer that only one tool knows about is
// half-built, and the reason was never a missing feature: it was the copies.
//
// Now: one list, derived views below. Add a zone HERE and every consumer
// follows (including the guards that enumerate what must be indexed).
export const MEMORY_ZONES = ['functions', 'insights', 'dao', 'capabilities', 'skills'];
/** Zones that live as <zone>/<slug>.md inside the memory root (skills do not). */
export const FILE_ZONES = MEMORY_ZONES.filter((z) => z !== 'skills');
/** Zones whose files must each have an index row (skills have their own check). */
export const INDEXED_ZONES = FILE_ZONES;
/** `functions|insights|dao|capabilities` — for href/regex matching. */
export const ZONE_ALT = FILE_ZONES.join('|');
/** Zones plus the raw daily layer — what memory_search accepts. */
export const SEARCH_ZONES = [...FILE_ZONES, 'daily'];

export const DAO_DIR = 'dao';
// （DAO_TABLE_HEADING 已删除：道层小节的括号部分在不同记忆里写法不同——
// （最抽象的指导思想）/（`dao/`），真实判据是 `^##\s*道层` 词干匹配；一个
// 从不与真实标题相等的完整常量只会制造「startsWith 静默失效」的同型 bug。）

// federation (three-tier mode): project truth sources -> federation layer -> global
export const FED_TABLE_HEADING = '## 项目索引（联邦层）';
export const FED_TABLE_HEADER = '| 项目 | 记忆规模 | 来源副本 |';
export const FED_CONSENSUS_HEADING = '## 跨项目共识';

// Daily-log structure is no longer imposed: the raw layer is free-form, so the
// plugin cannot assume a fixed '今日功能线索' heading. resolveOpenItems scans the
// whole file for still-open (non-✅) lines referencing the feature instead.
export const DAILY_SECTION = '## 今日功能线索'; // legacy template heading, kept for old logs
export const DAILY_OPEN_SECTION = '## 今日待观察'; // legacy template heading
export const RESULT_LABEL = { done: '完成', reverted: '已回滚', pending: '进行中' };

// Guard marker: a low-frequency, high-value memory that must never be judged
// cold just because it is not written to often (the "守护型" channel).
export const GUARD_MARK = '🛡 守护型';
export const GUARD_LINE = `> ${GUARD_MARK}：低频高价值，不做冷记忆判定（memory_write guard=true 写入，删除该行即恢复判定）。`;

// Granularity gates: a block/summary is a conclusion, not a process log.
export const MAX_BLOCK_CHARS = 900;
export const MAX_ROW_SUMMARY_CHARS = 110;
export const MAX_PRINCIPLE_CHARS = 200;
export const MAX_CONSENSUS_CHARS = 150;
export const CONSENSUS_HEADING = '## 决策共识 / 规范';

// The insight layer's RETIREMENT budget (R23). Every other zone has a shrinking
// mechanism: functions/ folds at maxFunctionBytes, skills retire, the index
// caps at maxIndexBytes. insights/ had none — a principle could only be added,
// never merged or retired, so a root that keeps writing accumulates a pile
// where most entries are single-source and half are invisible to recall.
//   maxInsights          soft cap on the number of principle files
//   maxSingleSourceShare the share of principles that may cite only ONE source
//                        area (those are 专项经验, not transferable 法)
//   minLedgerMisses      dangling .usage.jsonl hrefs before the evidence chain
//                        is called broken (1 is noise from a rename, a few is
//                        not: the ledger is the ONLY place corrections and
//                        confirmations are recorded)
export const INSIGHT_BUDGET = { maxInsights: 24, maxSingleSourceShare: 0.6, minLedgerMisses: 3 };

// R25: how many evidence-bearing files may vanish before the check speaks. One
// disappearance is a rename in progress (the ledger gets rewritten by hand); a
// batch is either a deliberate consolidation or an accident — and both deserve a
// sentence in the report, because the health check cannot tell them apart.
export const VANISHED_FILES_WARN = 3;
