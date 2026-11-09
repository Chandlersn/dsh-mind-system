# dsh-valves

心智系统的**两类阀门**：下行准入（原则是否已具体化到可执行）与上行准入（反例是否够格修改上层定义）。《心智系统开发说明书》§4.2 的最小落地——先跑起来，阈值全部暂定。

## 为什么做这个

心智系统此前只有"向上蒸馏"（memory 的 gateFa/gateDao），缺两件：

1. **向下约束没有负向通道**：知道"什么不能做"的经验（反复失败的序列、被证伪的判据）没有生效机制——下一个任务照样撞同一堵墙。
2. **阀门没有漏判分母**：只记"拦了多少"答不出"该拦而没拦的有多少"。全拒和全放在只有分子的指标里读起来一样。

本包补这两件，判据是纯函数、双侧记账、生效必须人工确认。

## 三个工具

| 工具 | 做什么 | 不做什么 |
|---|---|---|
| `valve_check` | 提名→代码裁决→留痕：down（具体化+黑名单+禁跳层）/ up（J1 防伪+量化阈值）/ principle（原则失效四判据） | 判定 accept/human_gate **不等于生效** |
| `valve_confirm` | 人工确认后写负向规则库（唯一生效通道） | 未经用户确认不得调用 |
| `valve_metrics` | 双侧账本：evaluated/admitted/skipped + missRate + reason/gate 分布 | 不自评"阀门在工作"——分布给读的人判 |

## 与 memory 的分工（判据单一实现）

- 层级写入闸门（gateFa ≥2 源、gateDao ≥5 法）**仍归 memory**——更严、已实战；本包不重复实现。
- 本包独有：**下行负向黑名单**（memory 召回时经桥自动注入已确认禁令，零配合）+ **上行评估留痕**（memory_insight/memory_dao 写入后把证据送账本，只留痕不改写入结果）。
- memory 经 `ctx.get('valves')` 运行时探测；本包不在时 memory 行为一分不变（N4 降级）。

## 阈值（全部暂定，待实测分布校准）

单一真值源：`src/thresholds.js`。技能正向 ≥5 次 + 成功率 ≥0.7（**只认外部证据**，self_report 拒）；负向失败 ≥2 次；判据五量化门（技能 ≥3、场景 ≥2、反例 ≥1、预测 ≥0.6、重叠 ≤0.7）；原则失效四判据任一触发。法→道不设量化门，永远人工。

校准原料就是 `valve_metrics` 的分布：missRate 接近 1 = 可能误杀，接近 0 = 可能没在管。改阈值走 config.thresholds（未知键/非法值装载时点名），不改常量。

## 数据

- `<dshHome>/storages/mind-valves.jsonl` — 追加式判定账本（allow/deny 双侧都记）
- `<dshHome>/storages/mind-negative-rules.json` — 已确认负向规则（同 id 覆盖为修订）

读失败 ≠ 空：ENOENT 是 `[]`，其它失败是 `undefined`——"没查成"不得当"没命中"放行（下行遇 undefined 转 human_gate）。

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
- 外层治理循环只落了判据核（checkPrinciple），归类与定时巡检未建。
- 灰度放量/批量回滚/层修改流程未建（说明书阶段 D/G，按路线后做）。