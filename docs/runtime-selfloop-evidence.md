# 通用自循环：证据

目标：**通用的自循环迭代系统**——核心不绑定某一个模板，且"经验→复用"这一环真正闭合。

本文记录朝该目标做的三项工作及其证据。所有结论都基于实测，包括我做错并纠正的部分。

## 1. 缺口盘点（先认定缺口，再动手）

| 缺口 | 实测依据 | 状态 |
|---|---|---|
| 只有一个配方，通用性未证 | 核心仅 1 处与 JSON 耦合（`compensation.js:40` 硬编码 verifierId） | 已补 |
| 自循环最后一环是空的 | `exceptions.js` 的 `patterns` 必须由宿主注入；`analyze()` 从不去存储里找可用模式 | 已补 |
| 无真实跨任务样本 | `minRuns=3` 阈值在，真实样本 0（全是 fixture） | 仍缺（需真实任务） |

## 2. 第二个配方：证明契约通用

新增 `recipes/csv-normalize.js`（`csv-normalize` / v1，验证器 `csv-source-output`）。

选 CSV 而不是再写一个 JSON 变体，原因就是要**换掉验证形态**：JSON 比较解析后的结构，CSV 必须自己实现行式解析（含 RFC4180 引号与逗号转义）、保持表头、并按需重加引号。如果引擎只为 JSON 定制，这个文件不可能在**不动核心**的前提下写出来。

关键点：**核心一行未改**。只新增 `package.json` 的导出 `./csv-recipe`。

测试（`test/csv-recipe.test.js`，6 项）覆盖：正常完成并写出预期字节、引号解析与最小化重编码、内容不符必须被验证拦下（而非写出即算成功）、源格式非法在准备阶段被拒、两个配方互不串味（注册 CSV 不等于启用 JSON）。验证器身份断言写成 `notEqual(..., 'json-source-output')`，防止"借用别人的验证器"这种假通过。

## 3. 自循环闭合：默认模式解析器

原状：`matchPattern` 能判定"已批准的模式可否替代分析"，但**没有任何默认实现去喂它**——只有调用方事先知道 pattern 身份才可能命中。经验在积累，决策从不查阅，环是断的。

新增 `src/pattern-resolver.js`：`createPatternResolver({ store, approvals, patterns, minRuns, minSuccessRate })`，返回 `resolvePattern(taskId, run)`，并把它接进 `AnalysisCoordinator` 的 `resolvePattern` 选项。

设计约束（每条都对应一个天真实现会犯的错）：

- **有证据不等于有授权**：无审批 → 不命中。证据只进分母，从不自己发证。
- **一次运行不能自造信心**：样本按 taskId 去重，"一个任务反复自修"永远够不到阈值。
- **审批是凭证，不是正文**：`confirmApproval` 不复制 pattern 文本，所以正文必须从**已登记的模式库**按 id 取回。这一点我最初写错了（见下）。
- **失败留在分母**：成功率不会因为忽略失败而虚高。
- **报告不等于许可**：`describePatternEvidence` 明确输出 `activatable: false`。

## 4. 消除引擎里的模板硬编码

原本 `compensation.js` 只有一个 `buildJsonCompensation`，里面同时写死了验证器 `json-source-output` 和工具名 `runtime.replace_json`。后果不是崩溃，而是**第二个配方走补偿路径会被拒**，且拒绝长得像"策略不允许"，掩盖了硬编码这个真实原因。

改为两层：

- `buildCompensation({ ..., verifierId, targetTool })`——通用构建器，验证器身份是参数；只有在源尝试**确实由该验证器**验证过时才成案。
- `buildJsonCompensation(input)`——JSON 模板的薄包装，固定它自己的绑定。

关键一点：包装器**不接受调用方传入 `verifierId` 覆盖**。否则任何一次观测都能为任意产物的撤销背书。这条我最初没写测试，变异 `json_wrapper_ignores_its_own_binding` 存活后才补上"精确夹具"的断言（原先那条用 csv 任务，即使包装器被污染也会因别的校验先失败而"恰好通过"）。

复核后 `src/` 里只剩包装器这一处 `json-source-output`，属模板专用约定而非引擎逻辑——引擎已是通用的。

## 5. 受限自动确认：让环路真正转起来（用户授权）

用户指示"这个权限可以开放一点点，跑起来看看，有问题再调整"。此前 `approvals` 恒为空，环路**一次都转不起来**——证据在积累，却永远无人复用。这不是安全，是系统没运行。

新增 `confirmApprovalAutomatically(pending, { automation, evidence, pattern })`，把人工闸门改为**有界的委托**，每条边界都可检查：

| 边界 | 规则 | 为什么 |
|---|---|---|
| 显式开启 | 必须传对象且 `allowAutomatic: true`，否则 `automation_disabled` | 没有默认开启的路径 |
| 命名责任人 | `operator` 必填 | 票据必须可归因 |
| 高于解析器阈值 | `minIndependentRuns ≥ 2`，且实测独立运行数不足即拒 | 首次证据永不自动确认 |
| 成功率下限 | 低于策略阈值即拒，缺失也拒 | 不四舍五入 |
| 人工复核优先 | `requiresHumanReview: true` 一律拒绝 | 人要看的东西机器不许代签 |
| 期限更短 | 取策略 ttl 与请求期限的较小值，上限 24h | 自动授权不该长命 |
| 版本绑定 | 签发时校验 `patternVersionOf(pattern)` 与请求一致 | 正文变了票据即失效 |
| 可审计 | 票据带 `confirmedBy: 'automation:<operator>'` 与 `automation` 元数据 | 人签与机签永久可区分 |

自动票据是**真正的 confirmed 审批**：`approvalApplies` 接受它，`revokeApproval` 照样能吊销。解析器侧用 `ticketFor()` 统一取票，已签发的记在 `issued` 里，避免每次调用重复签发。

**这次又抓到一个真实安全缺陷**：`proposeApproval` 原先**丢弃** `requiresHumanReview`，所以自动策略根本看不到"此模式需人工复核"，会照样代签。测试暴露后改为把该标记带进请求。对应变异 `review_requirement_dropped` 现在被杀死。

## 6. 我这轮踩的三个坑（如实记录）

**坑一：变异脚本自身有缺陷，误报 9/9 存活。**
第一次跑，9 个变异全部 "存活"。我没有当成"测试很弱"就收工——先核对 `node --test` 的真实输出格式（TAP `not ok N - 名称`），再逐步复现。真实原因是脚本的 staging 路径算错一层（`join(here,'..','packages','dsh-execution-runtime')` 多算了一级），测试文件根本没被正确装载。改用与既有变异套件相同的 `new URL('../', import.meta.url)` + fd 重定向后，立刻得到 7/9。

**教训**：变异"全存活"和"全杀死"一样需要怀疑。先证脚本本身能红。

**坑二：resolver 会凭空合成模式正文。**
最初写 `candidate.pattern ?? { patternId: candidate.patternId }`。探针发现正常审批**不携带** `pattern` 字段（`confirmApproval` 只返回凭证），于是 `approved` 恒为 undefined，resolver **永远返回 null**——自循环仍然是断的，只是"看起来"有实现。改为从显式 `patterns` 注册表取正文，并补测试"有审批但无正文时必须弃权"。对应变异 `resolver_invents_pattern_body` 现在被杀死。

**坑三：变异写法无效，伪装成"测试没牙"。**
`csv_verifier_accepts_any_parseable_output` 第一次存活。我以为是测试太弱，实际是我的变异只替换了条件的第一行，后面 `&& actual.every(...)` 仍在执行，判定根本没变。把整个条件一起替换后才被杀死。

**教训**：变异存活有两种可能——测试没覆盖，或变异没生效。不区分就去"加强测试"，会往正确的代码上加无效断言。

另有一次自造事故：对含中文注释的测试文件用了 PowerShell `Set-Content`，写成非 UTF-8 并损坏，已用 write 重写。**中文文件只用编辑工具改**。

## 7. 执行证据

```
node --test packages/dsh-execution-runtime/test/*.test.js
# tests 459 / pass 459 / fail 0

node packages/dsh-execution-runtime/scripts/verify-loop-mutations.mjs
{"baselineExitCode": 0, "killed": 13}

node packages/dsh-execution-runtime/scripts/verify-compensation-mutations.mjs
{"baselineExitCode": 0, "killed": 9}
```

9 个变异全部由**指定断言**杀死：

| 变异 | 摧毁的性质 |
|---|---|
| `reuse_without_approval` | 无策略也能复用 |
| `resolver_invents_pattern_body` | 凭空合成模式正文 |
| `self_repair_counts_as_independence` | 一次运行自造多样本 |
| `pattern_version_ignored` | 跨模板版本静默命中 |
| `revoked_approval_still_applies` | 撤销的凭证仍生效 |
| `failed_repair_leaves_denominator` | 失败退出分母 |
| `csv_verifier_accepts_any_parseable_output` | 只要可解析就算通过 |
| `csv_quoting_not_parsed` | 引号被当字面量 |
| `csv_recipe_borrows_json_verifier` | 借用他人验证器 |
| `automation_enabled_by_default` | 自动策略默认开启 |
| `review_requirement_dropped` | 人工复核标记被丢弃 |
| `automation_ignores_run_requirement` | 首次证据即可自动确认 |
| `automation_skips_version_binding` | 签发时不校验正文版本 |

## 8. 仍未达成

- **真实跨任务样本仍可能为 0**：`store.listPatternEvidence()` 已实现（按 signature 跨任务聚合、`independentTasks` 用 DISTINCT task id 去重），但真实运行数据尚未产生。自动化按阈值拒绝，环路在证据不足时**静默弃权**并回落到正常分析——这是设计行为，不是故障。
- 阶段5 对照实验（DR-17/18）需真实任务集。
- 引擎内的模板硬编码已清除（`src/` 仅剩 JSON 包装器一处，属模板约定）。
