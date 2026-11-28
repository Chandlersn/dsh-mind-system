**简体中文** | [English](README.en.md)

# dsh-memory-manager

把 [lantern 的 memory-function-org skill](https://github.com/Chandlersn/lantern/tree/main/skills/memory-function-org)
适配成的 **DeepSeek Harness（DSH）插件**：一套**以功能域为骨架、跨会话、跨项目**的长期记忆。

一句话区别：它不是"按项目存笔记"，而是按**功能域**（登录、构建、部署、UI 面板……）累积迭代史，
把**会重跑的操作**沉淀成 `functions/`，把**会重套的原则**蒸馏成 `insights/`，
把可复用程序写成宿主技能候选包，
索引只留一行摘要，并让每个会话开局就被注入这套纪律。

- 记忆工具、系统提示纪律、`agent/pre-step` 主动回忆钩子与 Web 记忆面板；部分面板操作经插件写入通道执行。
- `memory_write` 必填 `summary`，传 `currentState` 时刷新文件头；功能域稳定后用 `memory_index` 单独登记索引。
- 带机械体检（R0–R28 + 温度分析，规则号会增长故不写死条数），坏了能被检查出来，而不是靠记性
- **能力台账**：用过的外部 CLI / MCP / 本地工具（不含 harness 自带能力与本项目自己的脚本/API）登记在 `capabilities/`，下次同类任务先查台账，不重复摸索
- **技能结晶**：使用记录提名，`crystallize` 写入宿主技能目录包 `<dshHome>/skills/<kebab-name>/SKILL.md`。`agent_created: true` 标明自有包，可设 global/project 作用域。已有 active 技能可召回并通过可选桥发布；本版因缺少与技能版本和任务绑定的独立执行证据而暂停转正。
- **粒度有闸门**：迭代块只写蒸馏结论，块 >900 字或索引行摘要 >110 字会在写入时告警并由体检 R14 点名
- **凭据处理**：共用 Markdown 写入通道在落盘前替换可识别的凭据形态。直接编辑每日记录有不同的来源与脱敏边界；R21 可检查磁盘内容。
- **思想文件头**：按正向和纠正声明计算信任级，写入思想时刷新；R22 提示复核动摇的条目。这些计数不能验证原则成立。
- **时间检索（借鉴 Hindsight 的 temporal recall）**：`memory_search` 的 `after`/`before` 按日期区间过滤，每条命中带归属日期（迭代块标签→文件头→文件名→mtime 逐级解析）——"上个月怎么解决的"直接可查
- 面板配色/尺寸对齐 Host 设计令牌（`--dsw-alias-*` / `--dsw-radius-*`）

## 记忆布局

根目录默认 `~/.dsh/memory/`（`DSH_HOME` 环境变量或插件配置 `memoryRoot` 可覆盖）：

```
memory/
├── MEMORY.md              # 索引：功能表 + 思想表 + 能力台账表 + 技能台账表（每行一行摘要）+ 决策共识 + 环境常量
├── functions/<功能域>.md   # 每功能一个文件，追加式迭代块（日期只是标签）
├── insights/<主题>.md      # 可迁移原则（从具体功能向上蒸馏，回链来源）
├── capabilities/<能力>.md  # 能力台账：外部 CLI/MCP/本地工具怎么调、前提、解决过什么（项目自身脚本/API 不进这里）
├── dao/<名称>.md           # 正式命题
├── dao/_candidates/       # 召回范围外的候选
├── YYYY-MM-DD.md          # 每日原始素材
├── daily/YYYY-MM.md       # 已有月归档
└── legacy/                # 原型时代日志（须带“历史原貌”头部）
```

归口口诀：这是我会**重跑**的操作 → `functions/`；这是我会**重套**的原则 → `insights/`；
这是我会**照着一步步再做一遍**的程序 → `skills/`。
细节永远留在功能文件里，`MEMORY.md` 只写共识、环境常量和一行摘要。

## 数据流：单向五层，每层只吃上一层的产出

核心不是"按功能分文件"，而是**先有原料、后有提炼**——数据只向下流动，每一层都对上一层有据可查：

```
第 0 层 · 每日记录 YYYY-MM-DD.md（原始层，可经编辑工具筛选写入）
        当前可选采集只处理用户原话，默认关闭；助手判断尚无自动采集通道
        │ 归纳汲取（memory_write）
第 1 层 · functions/<功能域>.md 迭代块：动因 / 改动结论 / 判据 / 待观察（各一句）
        │ 再提取（memory_insight）
第 2 层 · insights/<主题>.md：可重套的原则（回链来源功能域，过「跨域 + 不可降级」双闸门）
        │ 整合展示（memory_index，功能域稳定后）
第 3 层 · MEMORY.md 索引 + 面板总览：一行摘要 + 计数，检索与呈现的派生物
        │ 结晶为程序（memory_skill，操作被反复重跑且确认后）
第 4 层 · <skillRoot>/<kebab-name>/SKILL.md：宿主技能目录包，只有 active 进入召回
```

- **思想自检**：写明来源及原则的适用范围、失效情形。单源产生专项提示。写后从磁盘回读检查反面边界，结果见 `selfCheck`。
- **共识条目必须带依据**：MEMORY.md 的「决策共识 / 规范」区由体检 **R19** 检查，
  单条 >150 字、没有任何记忆文件链接、或声称"跨功能/全局"却只指向 1 个来源域，都会报警。
  约束不是意见，它得能指回证据。

- **每日记录与采集**：编辑工具可筛选写入判断、取舍及待验证事项；直接编辑不自动脱敏或记账，可触发 R26 或采集基线拒绝。`captureUserTurns` 仅接受布尔 `true` 开启。下游允许该步进入后，钩子异步处理 `role=user`、`source.kind=user`、有非空 ID 和有效文本的消息，同 ID 内容冲突时跳过。跨文本块脱敏后默认截取 160 个码点。元数据和哈希不能认证来源，采集可能有缺口，助手判断须另行记录。
- **按月归档**：本版暂停自动归档，调整 `dailyArchiveFirstDelayMs` 或 `dailyArchiveIntervalMs` 不能启动调度。已有 `daily/YYYY-MM.md` 仍可按日读取、检索及在面板展开。
- **采集协议**：写前检查现有文件与账本基线，历史正文保持原样；合作采集进程以 SQLite 锁串行化（Node 22 的 `node:sqlite` 为实验性功能）。写入前留持久 pending 意图；崩溃后意图未完成则停写，不自动恢复或补账。文件与账本并非崩溃原子，非幂等副作用仍待处理；shell、旧版、其他非合作进程不受该锁保护。概览提供本实例状态及失败、意图现场，不代表全局或端到端送达。历史日记可能没有账本记录，缺口只能现场核查，不能补造来源。
- **历史保留与未知范围**：`memory_write` 的 `resolve` 不修改或勾选历史每日记录；`memory_rename` 不改写历史每日链接，可能留有旧名。R10 遇到根目录无法枚举或每日文件不可读，报告该范围未知，已发现死链数只是下界。
- **采集意图清理**：`finishCaptureIntent` 先把意图移至隔离路径、核验文件身份，再按路径删除；核验与删除之间仍有替换窗口。追加式意图日志仍是独立原型，该问题闭环前保持真实自动采集关闭。
- **一层比一层精炼、更普世**：每日层是过程，功能层是结论，思想层是普适原则，
  索引层是检索面。任何一层都不复制下一层的原文——同一事实只在一处为真。
- **索引是派生物不是同步物**：`memory_write` 不再自动写索引行与每日线索；
  功能域**稳定后**（≥2 个迭代块，或已可感知为独立主题）才用 `memory_index` 收进索引，
  行摘要从各迭代块的概括中提炼。
- **规模上限有出口**：功能表超过 ~40 行时按 `### 索引·<域>` 拆分子分区（如「基础设施」「业务功能」），
  `memory_index` 传 `group` 参数把行写进对应子表——分组即迁移，原来的扁平行会被自动移走，
  不会留下重复；`memory_check` 在表大而未分组时提示拆分。
- **两层闸门**：块正文 >900 字或概括 >110 字时写入告警，`memory_check` 同时报 **R14**。
  系统会收缩，而不只是增长。
- **收缩**：功能文件超 30KB 用 `memory_fold` 折叠最旧块（每块留一行：日期标签 + 标题 + 非"完成"的结果）；
  折叠后的标签仍参与同日编号（`补N` 不会撞名），早期结论留在「早期演化」段里可追溯。

## 层级定义：道 / 法 / 术 / 器

记忆库按"内容的普适程度"分四层。**每层先回答一个问题，答不上来就降一层**——这就是全部判据：

| 层 | 一句话定义 | 判据（一句话问句） | 存放位置 |
|---|---|---|---|
| **器** | 指向内容的指针与检索面 | 这是内容，还是指向内容的指针？ | MEMORY.md 双表 + 面板 |
| **术** | 一个功能域"怎么做"的完整迭代史 | 我会不会再跑一次这个操作？ | `functions/<功能域>.md` |
| **法** | 从具体操作提炼出的可套原则 | 换个项目/领域还成立吗？ | `insights/<主题>.md` |
| **道** | 由至少五条不同来源法推演的描述性命题 | 各条法如何共同支持它，何时不成立？ | `dao/<名称>.md` |

### 边界：什么不该进这一层（反例）

| 层 | 反例（放错了的样子） | 为什么是错的 |
|---|---|---|
| **器** | 把某个功能的推导过程写进索引行 | 索引是检索面；塞内容会让它臃肿且每处都要双份维护 |
| **术** | 在迭代块里写"以后所有项目都应该……" | 功能域只回答这一个域怎么做；普适断言在这里无法被验证 |
| **法** | 原则写成"1. 先运行 X；2. 再执行 Y" | 能改写成操作手册的就不是原则——步骤属于术层 |
| **道** | 把某项技术选型写成上位命题 | 选型依据归入功能域；操作约束另列 R19 检查的共识区 |

### 升降级：内容什么时候该搬家

```
每日记录（原始层，怎么记都行）
   │ 蒸馏：综合与同一主题相关的素材日
   ▼
术 · functions/<功能域>.md        ← memory_write 落点
   │ 提炼：≥2 个来源功能域都验证过这条判断
   ▼
法 · insights/<主题>.md           ← memory_insight
   │ 从至少五条不同的现有法共同推演命题
   ▼
道 · dao/<名称>.md                ← memory_dao
   │ 整合：稳定后收进行索引（派生物）
   ▼
器 · MEMORY.md 双表 + 面板        ← memory_index 落点
```

**升级是单向的，降级只发生在内容被推翻时**（`supersedes` 或 R18/R19 点名后重构）。
原则被推翻不删除——旧结论带取代标记留在原地，因为它记录的是"当时为什么这么判断"。

### 一条内容放错层的三个信号

1. **读它的时候上下文不对**：在功能域里翻到一句普适断言 → 该升到法层
2. **写它的时候要复制**：同一句话想写进两个功能域 → 该升到法层
3. **用它的时候没法判**：一条"原则"每次都要附带操作步骤才能用 → 该降回术层

## 工具

| 工具 | 作用 |
|---|---|
| `memory_distill_review` | `list` 列候选、素材版本、原文位置；读原文后可对精确版本提交 1–4000 字结论，`receipt` 查历史回执。扫描不完整时不能提交，仅同版本抑制提醒。 |
| `memory_retention_inventory` | 只读盘点配置的记忆根与默认 `DSH_HOME/storages` 中固定的后台文件类别、数量和字节；返回缺失、未知、失败及自动整理停用标记。默认存储目录可能并非活动 valves 自定义目录；不统计运行时 SQLite/WAL 或系统缓存，不返回用户内容，不代表全系统盘点或清理资格。结果是非原子快照，未知类别的计数是下界。 |
| `memory_read` | 读索引、功能、思想、道、能力、技能或每日记录。`live_flow` 是当次观测，`graph_evidence` 是历史架构检查。`operation` 按精确请求 ID 读有界操作账本；`object_trace` 和分页 `adoption_evidence` 按对象键查已记录的链路及声明。 |
| `memory_search` | **全库排序检索**：索引一行摘要之外还能搜正文，返回命中的分区/文件/行号/小节/片段/归属日期。只记得片段、说不清在哪个域或哪天时用它；`after`/`before` 按日期区间过滤（迭代块标签→文件头→文件名→mtime 逐级归属） |
| `memory_sag` | 在 SAG 已索引目录中检索原文片段、路径及行号。`limit` 默认 3、最多 10，`paths` 与目录级 `exclude` 可缩小范围。`status` 报告索引根，`file` 加独特 `phrase` 探测特定文件。服务不可用会单独报告。本版渲染把命中标为实验层线索；引用时回查原文并保留其证据属性。 |
| `memory_capability` | **能力台账**：`record` 登记一个用过的**外部** CLI/MCP/本地工具（调用方式、前提、解决过什么，就地更新一工具一文件；harness 自带工具与项目自己的脚本/API 不算）；`list` 开工前看一眼有什么可用；`read` 读某工具的完整台账 |
| `memory_write` | 从至少三个不同且非空的素材日综合一个迭代块，说明选材理由；顶层日记优先，缺失时检查归档日节。1–2 天须以「用户显式要求」「当日踩坑因果」或「安全约束」加冒号及具体理由声明豁免，零天拒绝。核验限于日期和正文，相关性由调用方声明。 |
| `memory_index` | **整合层**：功能域/思想稳定后把一行收进 MEMORY.md 索引（行摘要从迭代块概括中提炼）；表大时可传 `group` 落到 `### 索引·<域>` 子分区 |
| `memory_insight` | 写入可迁移原则，回链来源功能域，同步思想索引；可用 `supersedes` 标记旧思想。查看写入警告及磁盘回读自检。 |
| `memory_dao` | 候选和正式条目均校验 ≥5 条不同的现有来源法、命题形态、描述节、共同推演、适用边界和在用上限 7 条。`candidate` 写入 `dao/_candidates/`，候选不进召回；`list_candidates` 查看候选。`active` 或省略状态可直写 `dao/`，不提供独立人工批准凭据，也不自动登记索引。 |
| `memory_fold` | 功能文件超 30KB 时把最旧迭代块折叠成"早期演化"段（保留结论与全部日期标签） |
| `memory_rename` | 改名和合并均暂停。有效请求在写入前返回 `safe_rename_unavailable`。 |
| `memory_delete` | 下层有效删除请求在归档、移除文件及更新索引前返回 `safe_delete_unavailable`。道层由工具直接拒绝。 |
| `memory_check` | 体检：索引体积、缺摘要、孤儿文件、反向链接、日期乱序、死链、冷记忆、头部守卫、路径存活、块/行过详（R14）、重复行/表（R15）、纠正率熔断（R18）、共识条目无依据/过长/假跨域（R19）、旧布局残留与索引行-包状态对照（R20/R20e）、宿主包死链（R10 扫 bundle） |
| `memory_usage` | **使用信号**：`record` 记一次纠正/认可（召回与读取由插件自动记）；`report` 按窗口聚合，给出 实验/专项/通用 的分层建议（只建议，不自动移动文件） |
| `memory_federation` | **联邦模式**（可选）：`sync` 把各项目 `MEMORY.md` 复制进联邦层 `sources/` 并重建项目索引表；`check` 体检 F1–F5（索引存在、链接可解析、项目/副本齐全、无孤儿副本、绝对路径存活） |
| `memory_skill` | `candidates` 从 ≥6 次使用、≥1 个正向声明且纠正率 <20% 的域提名；`crystallize` 写宿主候选包，`list`、`read`、`retire` 可用。有效 `activate` 返回 `verified_skill_execution_unavailable`，有效自有包 `delete` 返回 `safe_delete_unavailable`。 |
| `memory_inbox` | **插件问题收件箱**：各插件经 `clis/health-finding` 事件自动投递，agent 也可用 `post` 主动报一条（去重靠来源+代号+消息指纹）；`list` 看队列（未处理在前，可按状态/来源筛）；`update` 在 open/acknowledged/resolved 间改处置；`delete` **彻底删除**一条（不可逆，用于误报或重复投递 —— 与"标记已解决"不同，后者保留记录）。面板「收件箱」页提供同一套操作，侧栏徽标显示**未处理**数 |

`memory_read(kind=adoption_evidence)` 按规范对象键分页读取调用方声明的正向或纠正信号，不认证人类身份、目标达成或原则归因，也不具备治理资格。新 `v2` 游标绑定对象、来源列表和所读内容摘要；旧 `v1` 游标返回 `incomplete/legacy_cursor`，需从首页重读。续页前来源变化时返回不完整，摘要不是认证，也不能保证跨文件原子快照或发现没有旧游标时的历史截断。旧账本枚举现在不读取文件正文，但枚举后其他调用方仍可能按路径重新打开文件；身份检查不能防止后续替换或 ABA，部分其他读取路径也不具备同样的字节上限。

`src/closure-evidence.js` 的 `classifyClosure` 是首次成长闭环的只读判据：它把召回、动作、结果、复核四跳按调用方提供的身份与来源分类，要求四跳身份一致且链接连贯才算 `correlated`，自产复核、身份漂移、actor 缺失或损坏、actor 与身份同名均不能算独立复核。它永不输出 `closureClaim=true`，因为闭环是否成立是人的判断；独立复核的布尔值也只是调用方声明，不是认证。判据与反例见 `tests/closure-evidence.test.js`。

概览的 `closureEvidence` 使用短时活动窗口，观察召回完成、工具进行中及工具完成。公开查询不接受任务 ID 或复核答案，因此只能说明窗口内出现过哪些事件，任务归属和人工复核无法确认。此版 `memory_read(kind=live_flow)` 返回活动边和丢弃计数。

系统提示里会注入一段纪律说明；`agent/pre-step` 钩子按用户输入与索引行的词元重合度打分，
把命中的索引行作为一条 `recall` 消息注入。打分以**词法分为主、使用信号只做有界加成**：

- **词法路（IDF 加权）**：几乎每行都有的词（「功能」「记忆」）权重低，稀有词（「逐帧」「懒加载」）
  权重高；行名/文件名命中加倍；低于最高分 40% 的行直接丢弃，同一文件只注入一次。
- **使用信号（`.usage.jsonl`）**：热度 = 实际触及次数 + 2×认可次数，并按纠正率降权。它以**最多
  +15% 的乘性加成**作用在词法分上——够用来打破并列、微调接近的候选，但**永远不会推翻真实的
  相关度差距**（一个 2 倍的词法优势不会被热度反转）。

> 为什么不是 RRF：RRF（`Σ 1/(60+rank)`）适合融合两个**同类**检索器（FTS5 + 向量），代价是丢弃
> 分数幅度只保留名次。这里一路是用户的原话、另一路是流行度先验，二者不是同类，名次融合会让
> 先验压过用户的话。
>
> 另一条同源修正：**`recall` 不算使用**。召回是插件自己的动作，把它计进 `uses` 会让插件用自己
> 的输出证明自己的价值（召回→变热→更多召回）。现在 `uses` 只计**触及**（读 + 判断），召回单列为**曝光**。

另外三点：**决策修复**——近 7 天被反复纠正的域（≥2 次且纠正率 ≥30%）即使词法不命中也强制并入
下一轮召回，并标注「先读它再动手」；**前台预算 3s**——整个召回尝试有绝对超时，超时**静默放行**
（不注入半成品、不拖慢该步），配置只能缩短不能延长；**召回预览**——`GET /api/memory-org/recall-preview?q=…`
跑同一条管线，逐行给出命中理由（名称命中/词法分/使用信号）与最终分，召回质量可调试而不是靠猜。

同一会话同一批只注入一次；用户文本已引用的文件不再注入；出错绝不影响该步。面板的 `/search`
与 `memory_search` 共用同一套排序。

## 使用信号与自组织分层

使用信号写入按月分片的 `.usage/YYYY-MM.jsonl`；旧 `.usage.jsonl` 和已有归档仍可读取。生产环境的自动压缩写入暂停。

| 信号 | 来源 | 含义 |
|---|---|---|
| `recall` | `agent/pre-step` 注入时自动记 | **曝光**（不是使用）：插件把它推到了模型面前 |
| `read` | `memory_read` 打开具体文件时自动记 | **触及**：模型主动去看了它 |
| `correction` | 调用方写入 `memory_usage` | 调用方声明的纠正 |
| `positive` | 调用方写入 `memory_usage` | 调用方声明的认可 |

**`recall` 只算曝光，不计入使用**：召回是插件自己的动作，把它当成"被用了"等于让插件用自己
的输出证明自己的价值。`memory_usage(report)` 因此分两栏显示——**触及**（读 + 判断）与
**曝光**（聚合字段 `exposure` 为召回数加读取数），分层建议与热度只用触及。纠正率的分母同样**排除召回**（`纠正 / (读 + 纠正)`），
否则一条被大量注入、偶尔被纠正的记忆会把纠正率稀释成个位数百分比，永远不触发任何告警。

`memory_usage(action=report)` 聚合后给分层建议——**这层借鉴自"用数据自己排序"的思路，但落到
只建议不擅动**：

- **实验层**：未达到专项或通用层条件
- **专项层**：触及 ≥3 次且至少一次明确认可（进入常规选择池）
- **通用层**：触及 ≥10 次、认可 ≥2 次、纠正率 <20%（可作默认推荐）
- 纠正率 >40% 且纠正 ≥3 次 → 建议**先重构再追加**，同时体检 **R18** 报熔断
- 同一对象多次在正向与纠正之间翻转，可结合备注核对是否涉及同一判断。计数不能认证调用者、证明采纳或任务成功。

此外，低频但高价值的记忆（安全审计、关键踩坑、兜底规则）会被"冷记忆"规则误伤——用
`memory_write(guard=true)` 给文件头打 `🛡 守护型` 标记，冷记忆判定就跳过它：**"很久没写"不等于
"可以丢"**。

## 安装（作为 profile bundle）

在 DSH 里用 `plugin_manager` 安装工作区里的包目录：

```
plugin_manager install_bundle  <本目录绝对路径>
```

安装成功后 `plugin_manager` 会返回 `application: applied`；面板出现在 Harness Web UI 侧栏（记忆图标）。

### 更新插件时的缓存行为

宿主具备 loader/registry 时可从面板请求服务端热重载；不支持时重启 DSH。客户端产物更新后刷新页面，在总览核对运行版本。

必要时在 profile 的 `cordis.yml` 里配置；将尖括号中的占位符替换为本机绝对路径，未使用的可选项可省略：

```yml
- id: memory-manager
  name: 'dsh-memory-manager'
  config:
    memoryRoot: '<absolute-path-to-memory-root>' # 默认 ~/.dsh/memory
    newFeatureGraceDays: 3                 # 冷记忆宽限期（天）
    maxIndexBytes: 10240                   # 索引舒适线
    maxIndexHardBytes: 15360               # 索引硬上限
    maxFunctionBytes: 30720                # 功能文件上限
    dshRoot: '<absolute-path-to-DSH-installation>' # 一般不需要，见下
    federation:                            # 可选：三层联邦模式（不配则单根）
      root: '<absolute-path-to-federation-root>'
      projects:
        - { key: project-a, root: '<absolute-path-to-project-a-memory>' }
        - { key: project-b, root: '<absolute-path-to-project-b-memory>' }
```

### 联邦模式（三层，可选）

单个全局根在功能域几十个以后会拥挤。启用联邦后分三层，**项目细节不上升**：

| 层 | 位置 | 内容 |
|---|---|---|
| 项目真相源 | 各项目自己的记忆根 | 该项目完整的 `MEMORY.md` + `functions/` + `insights/`，细节只在这里 |
| 联邦层 | `federation.root` | `sources/<key>.MEMORY.md`（各项目索引副本）+ 一张项目索引表 + **模型手写的跨项目共识** |
| 全局 | `~/.dsh/memory` | 只放跨项目共识与环境常量，不放项目细节 |

`memory_federation(action=sync)` 刷副本与项目索引行（机械内容，不覆盖你手写的共识小节）；
`memory_federation(action=check)` 跑 F1–F5 体检：索引存在、链接可解析、项目行与副本齐全、
无孤儿副本、绝对路径仍存在。**工具只搬副本，跨项目共识需要模型蒸馏后自己写**——不做假融合。

### 插件从哪里找 Host 包

profile 安装的 bundle 是 pnpm 链接，realpath 指向工作区源码，因此**裸 import 永远解析不到 Host 的
`node_modules`**。本插件用 `createRequire` 直接 require Host 安装目录里的文件（ESM + `require(esm)`，
Node ≥ 22.12），返回的正是 Host 已加载的同一份命名空间。

安装目录**自动探测**，顺序为：插件配置 `dshRoot` → 环境变量 `DSH_INSTALL_DIR` / `DSH_ROOT` →
从进程 CLI 入口（`process.argv[1]`）向上找 → 从 `process.cwd()` 向上找 → 从 `DSH_PROFILE_DIR`
向上找 → 本文件所在树。都找不到时会给出明确报错，提示设置 `DSH_INSTALL_DIR`。

## Web 面板

侧栏“心智管理”图标打开，提供阅读、检索和部分经插件通道执行的操作。**面板是数据看板**：顶部横向分区标签 + bento 网格总览，所有数字直接取自后端接口，没有侧边栏工作台。面板 exclusive 提交用 `.stage/` 受核验暂存 + inode 核验删除；每日记录按月组→周子折叠→日线索展示。源码改动需按宿主构建/热重载机制生效，不能仅凭源码推断运行中页面行为：

- **总览**：体检徽标（FAIL/WARN/冷记忆）+ 六个分区计数卡（功能/思想/道/能力/技能/当日）+ **运行环境卡**（正在运行的
  插件版本、宿主是否支持热重启、记忆根与技能库两个存储的位置、索引体积对舒适线/硬上限的填充条）+ **召回自检卡**
  （输入一段话，看真管线现在会注入哪些行、每行的命中理由与融合分，点行直接跳转）+ **跨分区「最近改动」时间线**
  （按 mtime 倒序，带索引里的一行摘要），先看"记忆最近长成什么样"
- **功能 / 思想 / 每日**：每个文件一行卡片，直接显示索引摘要（不用点进去才知道是什么）、相对时间、体积；
  可**按时间/名称排序**、**按名称或摘要过滤**；每日区按月份分组，天多了也不会变成一堵墙
- **道**：展示正式条目、候选及来源。候选确认、拒绝、删除以及正式条目删除均会校验请求；有效请求也在首次变更前以 `safe_delete_unavailable` 停止。会话授权不能证明真实用户批准。
- **技能库**：按 `agent_created` 区分自有和安装的宿主包。同一处可读正文、文件树及附带资源。缺少独立执行证据时启用开关禁用；退役可用，删除暂停。写操作经 `POST /skill-action` 校验。
- **热重启**：宿主具备 loader/registry 时可由面板请求服务端重载；受理后需查看最终结果和运行版本。客户端构建完成后刷新页面。
- **阅读**：功能文件按迭代块折起，默认只展开最新一块（短文件全展开），顶部日期跳转条 + "展开全部"；
  思想/每日按小节展开；索引页把"功能模块索引 / 创新优化思想索引"渲染成**可点击的导航表**，其余小节折叠。
  每日分区按**月组 → 周子组**折叠（2026-11 月/周折叠方案）：月头 `▾ YYYY-MM` 默认展开当月，
  周子组标 `周 YYYY-Www（MM-DD ~ MM-DD）`（ISO 周，周一为一周之始）默认展开当周；
  已归档月显示「月归档」按钮打开 `daily/YYYY-MM.md`（节内 `## 周 YYYY-Www` + `### [YYYY-MM-DD]` 日标题）
- **跳转**：正文里的 `functions/x.md`、`insights/y.md`、`YYYY-MM-DD.md` 链接在面板内跳转，不离开记忆视图
- **搜索**：顶栏全局搜索（防抖 350ms，≥2 字符），与 `memory_search` 共用同一套相关度排序；
  命中行带**命中词高亮**、分区标签、行号与小节标题；顶栏右侧的**分区筛选**（全部/索引/功能/思想/道/能力/技能/每日）
  直接带 `zone` 参数请求，只筛当前关键词的结果；某分区无命中时会提示"点全部看其它分区"而不是显示空；
  `/` 聚焦搜索框、`Esc` 清空/返回、`↑/↓` 在行间移动
- 每 30 秒静默刷新一次；面板自带的 `<style>` 只作用于面板根节点，随卸载移除
- **视觉贴合宿主**：字级 14/22、控件 36px/28px、搜索框 32px + `--dsw-alias-border-l4` + `--dsw-alias-bg-layer-1`、
  标签 11/17 且状态色走 `color-mix()`、焦点环 `--dsw-focus-ring-*`、正文链接 `--dsw-alias-link`、
  列表用宿主式细线行（不是卡片框）——都能在 `dsh-client-ui-primitives` 的 CSS 里找到同款

## 面板 HTTP API

面板数据全部来自 Host 路由 `/api/memory-org/*`。**记忆根由服务端解析，请求不能指定路径**
（不接受 `?path=`，因此无法被面板或页面请求指向任意目录）：

| 路由 | 说明 |
|---|---|
| `GET /api/memory-org/overview` | 体检结果 + 各分区文件计数 + 使用口径 + SAG 通道状态 + 运行环境（面板总览、架构图与侧栏徽标共用） |
| `GET /api/memory-org/stream` | **SSE 推送**（见下）：连上先发一份完整 `overview`，之后只在数据变化时再发 |
| `GET /api/memory-org/check` | 仅体检 |
| `GET /api/memory-org/list?zone=functions\|insights\|dao\|daily` | 分区文件列表（每日区只列 `YYYY-MM-DD.md`，最新在前） |
| `GET /api/memory-org/file?zone=functions&name=x.md` | 读记忆文件（省略 `zone` 读索引） |
| `GET /api/memory-org/search?q=关键词` | 全库搜索 |
| `POST /api/memory-org/{skill-action,inbox-action,axiom-action,dao-action,reload}` | 由宿主 connection 服务检查请求；缺少该服务时写路由返回 501，各动作另有执行条件。 |

### SSE 推送（`/stream`）

事件 `overview` 携带与 `/overview` 单元素数组中同构的对象。快照失败时可收到 `error`，定时 `heartbeat` 另报 `snapshotFresh`。

三条设计约束：

- **只在变化时推送**：整份 payload 序列化后比对，相同就不发。每秒无脑推是在搬同样的字节，且并不会比"变化那一刻"更新。
- **服务端内部每 2 秒检查磁盘**：记忆根是 agent 与编辑器直接写的普通文件，跨网络驱动器与各平台都没有可靠的事件总线，2 秒轮询是诚实的兜底（几毫秒服务端开销，不是浏览器往返）。
- **轮询保留为下限**：客户端同时保留 30 秒轮询。流断开时面板继续更新，只是慢一些——静默停止的监控比落后 30 秒的更危险。徽章上的"实时"是**新鲜度**承诺，事件超过 90 秒未到即显示为轮询降级。

HTTP 路由与 SSE **共用同一个 `overviewPayload()`**，避免两处装配漂移；`signalCount` / `indexRows` / `distinctHrefs` 的口径说明只写在这一处。

**两家半边约定好的字段名**（客户端只认这些；改名会让面板静默变空白，`api-test.mjs` 有专门的契约断言钉住）：

| 响应 | 字段 |
|---|---|
| `overview`（数组，单元素） | `root`、`initialized`、`failCount`、`warnCount`、**`results`**（体检条目：`level`/`rule`/`message`；不是 `problems`）、`counts{functions,insights,dao,capabilities,skills,daily,archived}`（`daily` **含归档月**在内，`archived` 只数 `daily/YYYY-MM.md`；2026-11 口径变更）、`usage{signalCount,recallEvents,readEvents,verdictEvents,distinctHrefs,indexRows,layers,hotspots}`、**`sag{configured,online,authorized,endpoint,tool}`**（三个布尔分开报，因为失败原因不同、修法不同：无 key / 服务没起 / key 被拒——合成一个"不可用"会藏住是哪一个坏了）、`capture`、`env{version,canReload,hotReloadRunning,memoryRoot,skillRoot,indexBytes,indexComfortBytes,indexHardBytes,lastReload}`（`skillRoot` 为**已解析**的存储路径：无覆盖时 = `<dshHome>/skills`，与 config 项同名同义） |
| `stream` | `overview` 事件携带单个概览对象，`error` 事件携带错误，`heartbeat` 的 `snapshotFresh` 表示快照新鲜度。 |
| `list` | `files[]{name,bytes,mtime}` |
| `file` | `{name,text}` |
| `search` | `hits[]{zone,name,line,heading,snippet}`（片段是 `snippet`，不是 `text`） |
| `skills` | `memory[]`（frontmatter 带 `agent_created` 的宿主目录包，含 `status/scope/files[]`）+ `host[]`（安装的技能，同形状）——一个存储两个视角 |
| `recall-preview` | `rows[]{href,zone,summary,fusedScore,reasons[]}`——真管线对该查询会注入什么 |

## 开发与测试

在包目录运行 `npm test`。`tests/run-all.mjs` 定位 DSH 宿主，找不到时明确失败，可通过 `DSH_INSTALL_DIR` 指定安装位置。测试入口包含工具、HTTP、UI 集成以及采集、归档调度、蒸馏和生命周期的专项测试。

## 许可

MIT，见 [LICENSE](./LICENSE)。
