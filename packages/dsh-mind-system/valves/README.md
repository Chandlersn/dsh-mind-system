# dsh-valves

心智系统的**两类阀门**：下行准入（原则是否已具体化到可执行）与上行准入（反例是否够格修改上层定义）。《心智系统开发说明书》§4.2 的最小落地——先跑起来，阈值全部暂定。

## 为什么做这个

心智系统此前只有"向上蒸馏"（memory 的 gateFa/gateDao），缺两件：

1. **向下约束没有负向通道**：知道"什么不能做"的经验（反复失败的序列、被证伪的判据）没有生效机制——下一个任务照样撞同一堵墙。
2. **阀门没有漏判分母**：只记"拦了多少"答不出"该拦而没拦的有多少"。全拒和全放在只有分子的指标里读起来一样。

本包补这两件，判据是纯函数、双侧记账、生效必须人工确认。

## 工具

| 工具 | 做什么 | 不做什么 |
|---|---|---|
| `valve_check` | 提名→代码裁决→留痕：down（具体化+黑名单+禁跳层）/ up（J1 防伪+量化阈值）/ principle（原则失效四判据） | 判定 accept/human_gate **不等于生效** |
| `valve_confirm` | 人工确认后写负向规则库（唯一生效通道） | 未经用户确认不得调用 |
| `valve_metrics` | 双侧账本：evaluated/admitted/skipped + missRate + reason/gate/origin 分布 + dailyCount | 不自评"阀门在工作"——分布给读的人判 |
| `valve_nominate` | 自动提名器（阶段 II）：负向吃 clis 失败账本重复签名、正向吃 memory 使用聚合；check=true 立即送阀落账。channel=clis_trace 消费 clis-history 提名+裁决成对留痕（幂等，账本当游标）；channel=criteria 从真实 insights 来源回链数覆盖喂五门，**也可传 `collide_notes` 让实验层碰撞笔记走同一道闸门**（见下） | 只提名不生效；不编造成功率与反例数（数不出的留空，阀门如实拒/downgrade——那是设计：先人工补外部证据） |
| `valve_govern` | 治理循环单轮（阶段 III）：账本→受检原则体检（引用覆盖率+反例四判据）→失效出改定义提议；归类提名代码校验（置信度 <0.7 转人工） | 不执行任务、不改规则库——提议生效走人工；不自动枚举全部原则 |
| `valve_repair_events` | 只读分页查看运行时修复收件：默认 20/最多 100 条、完整响应 64 KiB；缺库/损坏显式报告 | 原始生产者声明，不验证证据、不计入治理、不产生规则 |
| `valve_repair_identity` | 仅提供 producerId/eventId，经宿主绑定的运行时服务核对接收与生产记录；不接受数据库路径 | match 仅表示记录一致；文件/目标/原则归因未评估，治理资格始终 false |
| `valve_repair_artifacts` | 先核对双端身份，再由宿主在固定工作区复读证据文件：最多 32 引用、每文件 8 MiB、总计 32 MiB | match 仅表示当前字节一致；目标/原则归因未评估，治理资格仍 false；恶意文件系统竞争不在保证内 |
| `valve_repair_record` | 对精确事件重新执行宿主绑定的身份和文件复核，写入不可变技术审查快照；相同结果幂等，冲突不覆盖 | 不接受调用方指定路径或结论；不证明目标或原则，不进入治理消费。仅身份匹配且结果可核验时写入 |
| `valve_repair_review` | 按精确生产者与事件身份只读已保存的技术审查；缺库、缺行或损坏明确报告，数据库及 WAL 预检总计上限 64 MiB | 不重新检查当前文件、不建库；历史结果不是目标证明或治理消费；SQLite 临时 SHM 与协作式文件系统边界仍适用 |
| `valve_usage_correlation` | 必填小写 UUIDv4 `correlationId`，有界读取 memory 使用信号与 valves 接收账本，比较对象键、类型和备注 | 只读；两侧快照非原子，来源未经认证，匹配不证明人工采纳、效果或原则归因，不参与治理 |

`valve_usage_correlation` 返回 `compared`、`not_observed`、`duplicate` 或 `incomplete`；无效 ID 为 `incomplete`，原因为 `invalid_id`。重复标识、缺失、损坏或读取不完整不会伪装成匹配；备注缺失时备注比较为 `unknown`。结果不返回 ID、对象键、备注或原始错误；不追加读取信号或写规则，且不保证抵御恶意父目录竞态。当前为源码及隔离测试能力，真实宿主尚未验证。

审查游标固定追加行的高水位，使用上一页 `nextCursor` 继续；新增事件需开启新一轮读取。该机制依赖收件表只追加，不能当成跨删除、替换数据库或 VACUUM 的历史快照。单条 payload 最多读取 16 KiB，标识最多 1 KiB；超大/坏 JSON 记录仍返回行标识及错误状态。查询不调用可写接收器，也不创建缺失数据库。

### 覆盖率口径（III-2，单一真值源 src/governance.js）

- **引用覆盖率**：引用原则的判定数 / 窗口内合格的日常判定数。`valve_check` 的 `data.principle_refs` 只记录调用方明确声明的依据，不证明实际采纳；空数组表示明确未引用，未声明或格式无效表示未知。窗口内任何合格记录未声明时覆盖率为 `null`，并报告已声明与未声明数量。治理和巡检自身的记录不进分母。结果不确定或没有有效受检原则时，治理轮返回 `principles_uncertain`，不冒称 `principles_valid`。
- **语义覆盖率**：只能人工判读后显式传 `semantic_coverage`，报告标注 basis=human_semantic。
- **小样本保护**：窗口内样本 <10（暂定）不出覆盖率（null → checkPrinciple 走 uncertain）——3 条里 1 条引用的 0.33 是噪声不是失效。

### 样本口径（origin）

判定可标 origin：daily（日常，缺省语义）/ verification（部署验证）/ drill（演练）/ nomination（提名器产物）。总分布含全部样本，但 `dailyCount` 只数显式 daily——阈值校准与阶段 I 计数不拿验证样本灌水。历史行无 origin 归 untagged（不猜）。

## 与 memory 的分工（判据单一实现）

- 层级写入闸门（gateFa ≥2 源、gateDao ≥5 法）**仍归 memory**——更严、已实战；本包不重复实现。
- 本包独有：**下行负向黑名单**（memory 召回时经桥自动注入已确认禁令，零配合）+ **上行评估留痕**（memory_insight/memory_dao 写入后把证据送账本，只留痕不改写入结果）。
- memory 经 `ctx.get('valves')` 运行时探测；本包不在时 memory 行为一分不变（N4 降级）。

## 阈值（全部暂定，待实测分布校准）

单一真值源：`src/thresholds.js`。技能正向 ≥5 次 + 成功率 ≥0.7（**只认外部证据**，self_report 拒）；负向失败 ≥2 次；判据五量化门（技能 ≥3、场景 ≥2、反例 ≥1、预测 ≥0.6、重叠 ≤0.7）；原则失效四判据任一触发。法→道不设量化门，永远人工。

校准原料就是 `valve_metrics` 的分布：missRate 接近 1 = 可能误杀，接近 0 = 可能没在管。改阈值走 config.thresholds（未知键/非法值装载时点名），不改常量。

## 技能快速通道（II-4，2026-11-19）

技能候选量化门达标后**不再一律转人工**：若调用方声明 `confidence >= skillFastTrackConfidence`，直接 `accept`（reason `skill_fast_track`），并按 `skillAuditRate` 抽人回审。

| 阈值 | 默认 | 说明 |
|---|---|---|
| `skillFastTrackConfidence` | **1**（满档） | 0 = 关闭快速通道，回到全部转人工 |
| `skillAuditRate` | **0.3** | 0 = 不抽样（等于完全信任，账本如实记 `audit_disabled`）；1 = 每条都审（等于没开） |

**为什么默认满档而不是"刚好能过"**：实测 2026-11-19，7 次 skill 相关判定**没有一条**走到量化门（4 条 malformed、1 条 success_not_external、2 条 forbidden）。快速通道在当前语料上还没有真实流量——这是诚实的现状。把阈值调到"能产出样本"，等于拿结论去调判据。

**抽样必须可复现**：用 FNV-1a 哈希候选 id 落到 0–1 桶，不用 `Math.random()`。审计轨迹要经得起复核——同一候选重跑落进不同档，"它没被抽中"就无从验证。第一版测试用「单个 id 跑三次」验确定性，`Math.random` 变异**存活**了（三次恰好同档）；改成「8 个 id × 两轮、逐 id 比对」才杀死。

**自动生效必须留痕**：每次走快速通道都写一条独立账本行 `gate: skill_fast_track`，`action` 为 `audit_selected` / `audit_skipped`，并记下当时的 `audit_rate` 与 `confidence`。只写 "admitted" 的话，事后没人分得出哪些条目跳过了人工——那是自动了却没人观测的闸门。

**契约兼容**：量化门达标这个事实仍叫 `skill_thresholds_met`（旧名字不变），"快速通道为何没触发"放新字段 `fast_track_reason`（`skill_confidence_missing` / `skill_confidence_below_fast_track`），另带 `fast_track_bar`。直接改 `reason` 的语义会把依赖它的调用方和测试悄悄打红（层递链用例就会红）。

## 实验层回流（VI-5，2026-11-19）

碰撞笔记（`SAG-wiki/collide/`）是**自由文体**——2026-11-16 用户定：不套蒸馏格式，有真感触才写。所以它没有 `> 来源：` 行、没有 `## 核心原则` 节。**直接拿 insights 的解析器去喂它不work**（实测：`statement` 只剩标题、`coverage=0`、`evidence=[]`，阀门报 `no_evidence_record`）。

`collideNoteToCandidate()` 是给这种文体写的适配器。它做三件事，**且只做这三件**：

1. **提取笔记里真实存在的量化观测**（`5/5`、`91.7%`、`三比零`）；
2. **识别作者自己写的"会失败的观测"**——这是自由笔记里最有价值的证据，因为它在说"什么能证明我错了"；
3. **把笔记路径写进 evidence**，账本永远能回溯来源。

它**绝不做**的事：替笔记编 coverage、编反例数、编 `verifiable_by`。缺什么就留空，让阀门如实 downgrade 或 reject——**那才是要记的账**。给自由文体补一套好看的证据，等于把实验层变成进正典的后门。

**不许被误算的证据**：第一版正则把 `10:00`（周检时间）当成了量化观测。时间不是测量，而假观测会直接抬高 `skill_coverage`——正是闸门要数的那个数。现在时钟形态被显式排除。

**来源必须可区分**：候选带 `source_layer: 'experimental'`，`criteria()` 返回 `source_split{canon, experimental}`。一批全是实验层内容时，结果里一眼就能看出来，不会读成"正典提名"。

**实测结果（2026-11-19，两篇真实笔记）**：

| 笔记 | 裁决 | 理由 |
|---|---|---|
| 存在被当成了运行 | `downgrade` | `not_externally_verifiable`（没写可检验路径） |
| 删掉的东西，还在被我召回 | `reject` | `insufficient_skill_coverage`（1 个量化观测 < 门槛 3） |

两条都被拒，**且拒的理由都成立**——这说明闸门在真干活，不是通道没接通。

## 数据

- `<dshHome>/storages/mind-valves.jsonl` — 追加式判定账本（allow/deny 双侧都记；`kind: 'trace'` 的行是 LayerTrace）
- `<dshHome>/storages/mind-negative-rules.json` — 已确认负向规则（同 id 覆盖为修订）
- `<dshHome>/storages/mind-rule-triggers.jsonl` — 负向规则命中流水（供沉底与灰度转正判据）

读失败 ≠ 空：ENOENT 是 `[]`，其它失败是 `undefined`——"没查成"不得当"没命中"放行（下行遇 undefined 转 human_gate）。

## LayerTrace（执行面留痕，2026-11-16）

[`src/trace.js`](src/trace.js)。决策账本记的是"判了什么"，答不了三个复盘问题：经过了哪些层（没有 `layer_path`，单层校验和全链通过长得一样）、当时哪版规则在生效（事后改规则会让旧决策看起来像按现文本做的）、哪些闸门真跑了（跳过的闸门绝不能读成通过的闸门）。

四个契约字段写进**同一条** `mind-valves.jsonl`，不建第二存储——读者不可能只看到决策看不到 trace：

| 字段 | 内容 |
|---|---|
| `layer_path` | 有序层名数组，如 `["L2","L1"]` |
| `rule_versions` | 按层记版本；**只有真实声明过版本的层才入表** |
| `budget_usage` | 实际规模 + 上限（"44 of 120"是证据，"ok"不是） |
| `gate_decisions` | `[{gate, result, reason?}]`，`result ∈ passed / failed / skipped / human_gate` |

两条不可让步的规则：

1. **观测不到的字段恒为 `null`，不用 `0` / `{}` / `[]` 冒充。** `[]` 会读成"没有层"，`{}` 会读成"没有规则"。
2. **跳过的闸门记 `skipped`，不记 `passed`。** 语义层没有 embedder 是常态，没查过不能算通过；`verifyTraceFields` 把它单独列在 `skipped_gates` 里——既不冒充通过，也不因此判整条 trace 不完整。

`appendTrace` 是尽力而为的写入（存储坏了返回 `false`，不抛错）。旧账本没有 trace 行仍可读，历史不追溯补写。

## 灰度放量（IV-1，2026-11-16）

新确认的规则以 `rollout: 'staged'` 生效，**拦截力与 `full` 完全相同**（两条通道都拦，差别只在"这条规则被多少真实语料验证过"）。累积 `negativeRuleStagedHits`（默认 3）次真实命中后由 `promoteStagedRules` 转 `full` 并记 `promoted_at`。

约束：

- **转正只发生在真实命中路径**（`matchNegative`）。定时器或人工批量转正等于绕开证据。
- **沉底优先**：`status === 'sunk'` 的规则不会被转正复活。
- **读不到触发流水则一律不转正**——"读不到"不等于"没命中"，更不能当命中。
- **放量进度是正交字段，不写进 `status`。** `status` 是生命周期（active/sunk），被沉底、回滚与探针共同依赖；把它挪作灰度语义会连带改掉那些判断（实测直接打红两条沉底用例）。

## 探针

| 代号 | 含义 |
|---|---|
| `valves.ok` | 装载且三工具注册 |
| `valves.not-loaded` | apply 未执行 |
| `valves.tool-missing` | 工具注册不足（多为宿主定位失败） |
| `valves.thresholds-overridden` | 阈值被配置覆盖 |
| `valves.store-unreadable` | 账本/规则库读失败 |

## 配置

```yaml
config:
  storageDir: ''        # 缺省 <dshHome>/storages
  dshRoot: ''           # 宿主安装目录（缺省自动探测）
  thresholds: {}        # 覆盖暂定阈值（键必须在默认表里）
  layers: []            # 层注册表（缺省 L0-L3；层可修改，谓词不写死层名）
```

## 开发

```
npm test                    # 判据穷举 + 账本 + 桥集成
node test/mutation-check.mjs  # 变异验证：改坏判据必须红
```

## 借鉴出处

《心智系统开发说明书》（用户，2026-11）§4.1/4.2/4.5/9.2；clis_metrics 的漏判分母口径；memory-manager 的 layer-gate 分工与 fire-and-forget 记账纪律。

## 已知限制

- 负向匹配是关键词包含，不是语义相似度（§4.8 的 embedder 是后续可选增强，缺了降级不阻断）。
- 技能闸门的"高置信度快速通道"未开：v1 全部转人工，等真实分布出来再放。
- 定时巡检已建（周检 + 季度巡检，报告落盘 `storages/mind-patrol/`）：受检原则未配置时从记忆根 `insights/` 与决策账本自动枚举，周检每份含召回边界段（`_deleted` 排除、新增主题 diff、探针三态如实记）与引用充分性判定（`refs_basis`）。但外部召回探针需调用方配置回调——未接时召回边界段只有盘点与上期对照，违例数记 `null`（未知）而非 0；外层治理循环仍有单轮体（valve_govern 提议不自动生效）。
- 灰度放量/批量回滚/层修改流程未建（说明书阶段 D/G，按路线后做）。
- 提名器正向侧需要调用方传入 usage 聚合（不反向 import memory）；未传时如实报"本次未查"。