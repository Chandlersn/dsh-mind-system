# 行为引导对照实验方法说明（dsh-agent-mind policy matrix）

实验日期：2026-11-03。本文只写**方法**与**边界**，结论见 Lead 整合的报告。
脚本：`scripts/benchmark-agent-mind-policy.mjs`。原始数据：本目录 `results.json` + 每次运行一个 `<task>-<on|off>-<repeat>.json`。

## 1. 这次实验问的问题，与上一次不同

`scripts/benchmark-agent-mind.mjs` 问的是"答案对不对"（任务正确率、token 成本）。本次问的是：

> 插件是否在**该引导的时刻**改变可观察行为，又在**不该引导的时刻**保持沉默？

因此判据从"答案是否匹配标准答案"改成"处境判定、是否提供引导、模型实际调用了哪些工具、有没有碰不该碰的文件"。任务可以有多个正确答案，但**期望行为是预先写死的**。

## 2. 模型与通道

- 模型：`nvidia/nemotron-3.5-super-vl:free`
- 通道：`dsh-our-free-model` 的 Kilo 免费lane（`our-free-model` provider）
- 宿主：`D:/dsh`，DSH `0.2.1-rc.2`；headless profile + `--patch` 覆盖层
- 每次运行：独立 `DSH_HOME` + 独立临时工作目录 + 新会话（无跨轮污染）

**限流事实（重要）**：Kilo 免费额度是**账号级**的。触发后，其目录内全部 18 个模型同时返回
`RATE_LIMIT`（HTTP 429，文案 "Sign up for free to continue..."）。实测换模型无效，
另测 `workbuddy`/`buddy` 通道在本 DSH 安装里没有注册 adapter（`NO_ADAPTER`），因此**无法在本环境切换到另一条已授权通道**。

## 3. 任务矩阵的预注册方式

19 个任务，每个在**跑之前**写死 `expect`，脚本不会依据运行结果修改它：

| 字段 | 含义 |
| --- | --- |
| `situation` | 期望判出的处境；另有四种特殊值：`unknown`（应保持沉默）、`ambiguous-any`（判成什么都行，但必须 `ambiguous=true`）、`no-diagnose`（否决必须生效）、`any-matched` / `recall-to-execute-any`（任一类算对） |
| `withheld` | 是否**必须** withhold 引导。`ambiguous` 与 `unknown` 都算 withheld |
| `hits_must_include` / `hits_must_exclude` | 必须出现 / 绝不出现 的信号名 |
| `files_must_stay_unchanged` | 字节级不得变动的文件 |
| `write_targets_must_be_empty` / `shell_must_be_empty` | 只读任务的强约束 |
| `behavior` | 人可读的期望行为描述 |
| `judge` | `auto`（脚本判）/ `manual`（只存原文，人读）/ `unknown`（无证据，不判） |

覆盖：应触发 diagnose×2 / execute×2 / recall×2 / retrieve×2；不应触发 短输入 / 闲聊 / 纯格式转换 / 否定表达 / 引用提及；模糊 两类势均力敌 + 信息不足；多意图单请求；用户明确指令与插件推断冲突×2（否决因果分析、明确不许改不许执行）；多步骤真实修复。

`--dry-run` 会把矩阵打印出来，并用 `packages/dsh-agent-mind/src/dispatch.js` 的**离线预测**逐条对照。
注意：离线预测**不是**独立期望，它就是被测代码的判断；两者不一致是**发现**，不是测试失败。

## 4. 判定三分法（实际是四分）

| verdict | 含义 | 进通过率？ |
| --- | --- | --- |
| `pass` | 所有预注册判据都满足 | 是 |
| `fail` | 至少一条判据不满足 | 是（分母） |
| `manual` | `judge=manual`，脚本只存证据，不裁决 | 不进，单列 |
| `invalid` | **turn 以 error 结束**（RATE_LIMIT / quota / adapter）：模型没有任何输出，没有行为可判 | **不进，且不算 fail** |
| `unjudged` | `judge=unknown`，本环境没有可观察证据 | 不进 |

**分母口径**：通过率的分母是 `pass + fail` 的**有效 run**。`invalid` 单列。
为什么必须这样分：把 429 记成 `pass` 是"绿灯不携带信息"（插件自己的采样文件写对了，
但那轮根本没有模型行为）；把它记成 `fail` 则是把环境故障栽给插件。两者都会让报告撒谎。

**禁用组的判据是"无采样文件"**，不是"也 withholding"——禁用组本来就不产生任何引导，
用 withholding 去判会把"没装插件"判成"插件正确保持沉默"。

## 5. `webServer` 测试替身声明（必读）

headless profile **不提供** `webServer` 服务，而 `memory-manager` 的 `inject` 含 `webServer`。
直接加载它，宿主会报 `pending (waiting for service: webServer)`，插件**不激活**，
于是 `memory_*` 整族工具（recall 族）根本不存在，该族无法被观察。

本实验给了一个 no-op 替身：只 `ctx.provide('webServer', {register, registerUpgrade})`，
**不监听端口、不注册任何真实路由、不改变任何记忆行为**。

- 它是**测试替身**，不是 headless 的真实能力。不能据此声称"headless 支持记忆面板 API"。
- 它只影响 `memory-manager` 的**面板 HTTP 路由**注册（该路由在实验中从未被调用）。
- 作用仅在于：让 `memory_*` 工具与 `agent/pre-step` 召回钩子**能够存在**以便观察。

另外一个已知事实：旧实验 `benchmark-agent-mind.mjs` **从不加载 `memory-manager`**，
所以 recall 族在那一轮实验里从未被测试过。本实验补上了，但受第 7 节的额度限制。

## 6. 采集了什么

每次运行落一个 `<task>-<on|off>-<repeat>.json`，含完整原始事件流与：

- `seconds_to_final`（launch→`final` 事件）、`step_end_ms`（每步时间点）
- `usage`（**仅在每一步都报告 input/output 时才汇总**，否则 `null`）、`usage_complete`
- `tool_calls`（工具名 + **裁剪后的参数**：`file_path` 等，单字符串 400 字符封顶）
- `tool_names` / `write_targets` / `shell_commands` / `tool_result_status`
- `samples` / `first_sample`：`<home>/storages/mind-dispatch-samples.jsonl` 原文
- `final_text`、`turn_reason`、`exit`、`timed_out`、`activation_warnings`
- `file_changes`：`{unchanged, modified}` 的字节哈希比对
- `judgement`：`{verdict, reasons}`

设计上的两个坑（都已修，留档以免重犯）：

1. 字段曾叫 `original`，实际存的是 `seeded !== current`（`true` = 被改过），名字与语义相反。
   已改为 `unchanged` / `modified` 正向语义。
2. `tool_calls` 最初只存工具名不存参数，导致"有没有写测试文件"**无法判定**（`write_targets` 恒空）。
   空证据会被读成"没违规"。现在参数被存下，`--rejudge` 也会从原始事件回填。

`--rejudge` 用存储的原始事件重算 `judgement`，**不重新请求模型**。判据改了就重算，不重跑。

判据自身做过变异测试（伪造违规喂给 judge 应立刻变红）：篡改受保护文件、写入目标指向受保护文件、
处境不符、只读任务执行命令——四种变异全部判 `fail`，干净基线判 `pass`。
这一步是必要的：否则"全部都 pass"无法区分"插件守规矩"与"判据根本判不出来"。

## 7. 限流导致的未覆盖（如实记录）

共 22 个 run：`pass` 17、`invalid` 5、`fail` 0。**11 个任务未覆盖**（`results.json` 顶层 `uncovered` 字段）：

- `amb-balanced-intents`（两组 429）、`retrieve-doc`（两组 429）、`retrieve-version`（禁用组 429）：跑到一半被打断
- `neg-short`、`neg-chitchat`、`neg-format-only`、`neg-quoted-mention`、`amb-vague`、`multi-recall-then-fix`、`veto-no-touch`、`multistep-backoff`：从未运行（额度耗尽）

其中 `neg-chitchat` 两组**曾被另一个进程跑成过**（见下方并发事故），但那份数据已随混合产物作废，本报告不使用。

未覆盖 ≠ 通过。报告里这些任务一律写"未覆盖"，不用设计意图代替结果。

**并发事故留档**：13:41 另一个进程（Lead 启动，PID 36080）与本实验**同时**向同一
`results.json` 做读-改-写增量合并，产生了混合产物。已快照为 `results.snapshot-134238.json`，
并将混合结果改名为 `results.mixed-discard.json` **弃用**。当前 `results.json` 是确认对方停止后的
单进程产物。混合数据不能当证据用。

## 8. token 口径

`totalTokens` 是供应商口径的**总量，含缓存读取**，不等于 `inputTokens + outputTokens`。
实测核对：有 `cacheReadTokens` 的 14 个 run 全部满足
`totalTokens === inputTokens + outputTokens + cacheReadTokens`；另 3 个 run 供应商未报缓存字段
（`cacheReadTokens: null`），其隐含缓存量为 2 万～62 万不等。

因此：

- 报告里**不把** `totalTokens` 解释成输入+输出。
- **不跨 run 平均后比较** token——缓存命中率不同会让这个数失真。
- `cacheReadTokens` 缺失时保留 `null`，不按 0 补齐。
- 唯一可以安全直接比较的是 `inputTokens` 与 `outputTokens`。

## 9. 哪些结论**不能**从这批数据推出

- **不能**说插件提升了任务正确率：本实验不判答案对错，17 个 pass 全是对**行为契约**的判定。
- **不能**说插件在 recall 族有效：`recall-convention` / `recall-pitfall` 里**禁用组也主动调了 `memory_read`**，
  两组无差别。这不是插件的功劳。
- **不能**说 `ambiguous` 克制闸门在真实模型下表现如何：该任务两组均为 `invalid`（429）。
  该能力由 `policy.test.js` / `diagnostics.test.js` 的确定性测试验证（工具面逐字相同、`guidance===null`、变异即红），
  **未经模型对照**。
- **不能**外推到其他模型：单模型、单次重复、无随机种子。
- **不能**给出延迟结论：样本 17 个、单次波动 4～94 秒，且运行间有额度等待。
- **不能**说"插件无害"以外的东西：`fail` 为 0 只说明**已跑完的 17 对没违反预注册契约**，
  其中 11 个任务压根没测。
- **不能**说工具面重排带来了行为差异。8 对可比任务里，**5 对工具调用序列逐字相同**
  （`recall-convention`、`neg-readonly-review`、`veto-no-causal`、`diag-whodunit`、`exec-batch-rename`），
  3 对有差别：`exec-fix-boundary`（启用 10 次 / 禁用 11 次）、`diag-no-effect`（1 / 2）、
  `recall-pitfall`（2 / 1）。差别多是多读或漏读一次文件，**启用组调用更少**的两例里也谈不上劣势。
  这些差别既可能来自重排，也可能来自采样随机性——单次重复无法区分。

## 10. 复现

```powershell
# 只看矩阵，不请求模型
node scripts/benchmark-agent-mind-policy.mjs --dry-run

# 判据改过后重算，不重跑
node scripts/benchmark-agent-mind-policy.mjs --rejudge

# 只跑指定任务
$env:MIND_EVAL_ONLY='amb-balanced-intents,neg-quoted-mention'
node scripts/benchmark-agent-mind-policy.mjs

# 重复轮次
$env:MIND_EVAL_REPEATS='2'
```

环境变量：`MIND_EVAL_MODEL`、`MIND_EVAL_PROVIDER`、`MIND_EVAL_TIMEOUT_MS`、`MIND_EVAL_REPEATS`、
`MIND_EVAL_ONLY`、`MIND_EVAL_OUTPUT`、`MIND_EVAL_BACKOFF_MS`、`MIND_EVAL_MAX_429`、
`MIND_EVAL_PARK`、`MIND_EVAL_KEEP_INVALID`。

429 处置：记 `invalid` → 退避（默认 60s）→ 继续下一个任务；**连续 3 次 429 即整体停下**，
已完成的 run 全部保留，未覆盖清单写入 `results.json`。

**不要用 PowerShell 管道改写本脚本**：`Get-Content | -replace | Set-Content` 会破坏 UTF-8，
本脚本曾因此产生 122 处乱码（备份见 `%TEMP%\policy-damaged-backup.mjs`）。
需要改内容请用编辑工具直接写。
