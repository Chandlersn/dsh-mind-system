# 首次真实闭环迭代报告

日期：2026-11-18。试验目录：[first-repair-csv-observed](first-repair-csv-observed)。

## 结论

**同任务闭环已经真实跑通一次**：任务第一次执行写出错误产物，验收器拒绝；失败证据被送给分析通道，得到 `retry_with` 提案；宿主把提案作为一次性修复派发；第二次执行由**同一个验收器**判定通过。

这不是把失败重描述成成功。第一次失败和第二次成功是同一个 `taskId` 下的两条独立 attempt，都有派发、工具调用、文件读取和验收事件。`scripts/first-repair-audit.py` 直接检查原始 SQLite 和磁盘字节，不依赖运行时对象或叙述。

## 实测链

| 环节 | 外部证据 |
| :--- | :--- |
| 任务 | `empty-csv-eebd1363-5f9b-45ef-8434-545b9de22256` |
| 宿主 | 安装的 Cordis + ToolRuntime；[mount.json](first-repair-csv-observed/mount.json) |
| 首次执行 | 入口返回 `waiting_analysis / output_invalid_csv`，[entry-result.json](first-repair-csv-observed/entry-result.json) |
| 首次产物 | `id,name\n\n`，9 字节；SHA-256 `fa56df87…f290` |
| 诊断输入 | 失败候选、执行摘要、验收结论和证据引用均在 [packet.json](first-repair-csv-observed/packet.json) |
| 诊断输出 | `retry_with`、无人工审核、目标哈希与失败产物绑定，[response.json](first-repair-csv-observed/response.json) |
| 持久化分析 | `521c2a84-ddf8-45be-b28c-889c43c8a0b9`，状态 `proposed`，随后被消费 |
| 修复执行 | `d7cc9b02-5380-4d3f-addb-0a447bba76c0`；第二次 attempt 2 次工具调用、1 次分析调用 |
| 最终结果 | `completed / csv_source_and_output_verified`，[repair-result.json](first-repair-csv-observed/repair-result.json) |
| 最终产物 | `id,name\n`，8 字节；与原输入 SHA-256 均为 `40d6bfdc…42c1` |
| 验收器 | 两次均为 `csv-source-output@1`，没有换判据 |

完整工具事件在 [calls.jsonl](first-repair-csv-observed/calls.jsonl)：首次 `runtime_write_text`、分析请求、受限的 `runtime_replace_owned_csv` 和一次性修复入口，均未报错。

复核命令：

```sh
py -3 scripts/first-repair-audit.py docs/first-repair-csv-observed
```

输出中的首次原因是 `output_invalid_csv`，第二次是 `csv_source_and_output_verified`。删除 `runtime.sqlite-wal` 与 `runtime.sqlite-shm` 后重新审计仍通过，证据不依赖未落盘的临时文件。

## 模型参与的准确边界

诊断确实经过真实 Analyzer 通道：安装在 Cordis 的插件向本地中继发出 `instructions` 与失败包，中继保存了两者，再返回 RepairAction。该动作进入持久化分析表并被修复控制器消费。

但本次 `response.json` 是**人为指导的会话给出的动作**，[mount.json](first-repair-csv-observed/mount.json) 中模型名明确为 `human-directed-session-model`。因此这次证据证明的是“外部诊断结果接入闭环”，**不证明某个 API 模型独立完成了诊断**。要声称后者，需把该文件换成可核实的模型请求与响应，并保留同样的任务、验收和审计链。

## 产品侧接线边界

同一轮还补了原生 `runtime_run` 的一次性修复入口。可信任务模板显式声明 `autoRepair:true` 时，入口会检查本次持久化的提案、模板版本、调用方工具授权和人工审核标记，再调用一次 `scheduler.repair`。结果仍由原模板验收器判定，提案不会自行扩大权限。

[原生入口测试](../packages/dsh-execution-runtime/test/native-repair-entry.test.js)覆盖四种情况：授权且启用时完成一次替换；要求人工审核、缺少替换工具授权、保持默认配置时替换次数均为 0。这四项使用受控模型响应，验证的是宿主接线，不是模型诊断质量。

上面那次真实闭环的第二次写入，用的是试验脚本本地注册的 `runtime_replace_owned_csv`，带来源、输入版本和失败产物哈希约束。**产品默认宿主没有这个替换工具**，所以不能说默认安装已经能完成这同一个 CSV 修复。JSON 模板已有受约束的替换策略，但还需要宿主提供受信任的替换工具，该工具不在本轮改动中。

## 根因修复

CSV 配方在零行时生成了 `id,name\n\n`。现在把所有行先组成数组再统一加一个结尾换行，新增测试要求 header-only 输入只输出 `id,name\n`。验收器未改动：它原本正确拒绝了多余的空行。

## 回归

- 运行时测试 564/564 通过，无失败、无跳过。
- 仓库全量检查通过，发布检查 ALL PASS。
- 原始 SQLite 审计通过，删除 WAL/SHM 后仍通过。

## 下一步

1. 让一个可核实的 API 模型对相同失败包独立给出动作，并保留请求与响应证据。
2. 把带哈希检查的替换工具做成宿主能力，并明确哪些模板可授权，再用产品默认入口复跑一次。
3. 需人工审核的动作保持停止；自动修复不扩展到不可逆写入。
