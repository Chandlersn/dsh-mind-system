# 阀门账本阶段 I 基线与周检记录

> 用途：UPGRADE-PLAN.md 阶段 I 的数据锚。每周检追加一节；只记读数与结论，不记过程。

## 2026-11-09 · 基线（阶段 I 启动日）

### valve_metrics 读数

- evaluated=10, admitted=4, skipped=6, missRate=0.6
- byReason: not_concretized×1, success_not_external×1, principle-invalid×1, forbidden_skill_thresholds_met×1, human_confirmed×2, negative_rule_hit×3, concretized×1
- negative_rules=1（forbidden-inspect-query-explicit-input）
- **口径注**：10 条中 3 条是部署验证样本、7 条是 I-2 闭环验证产生。I-1 要求的"≥30 条非部署验证"从明日起算，当前计数 **0/30**（I-2 验证样本与日常样本在账本里无标记区分——此为已知口径缺口，见下）。

### I-3 首轮校准结论：**不调阈值**

依据：全部真实判定仅 1 组（I-2 的 forbidden_skill，failure_count=2 恰在阈值上，判定正确）；其余 reason 各只出现 1 次且多为验证样本。分布不足以支撑任何调整。按纪律记录"分布不足以调"而非硬调。

### I-4 填写率基线：0%（0/0 有效样本）

桥今日上线，尚无上线后的 insight 写入。现有 insights 全部早于 valve_evidence 参数。基线记 0 样本，下周检起算。

### I-2 闭环证据

1. 真实失败源：clis-interventions.jsonl 2026-11-09T07:33 同签名 hinted（cordis_inspect_query 带 input 被拒 ≥2 次，本会话转录可查）。
2. valve_check up → human_gate（forbidden_skill_thresholds_met）。
3. valve_confirm 生效（用户授权"按推荐执行"）。
4. **首版关键词误杀实测**：关键词选工具名（cordis_inspect_query）导致合规路径也 deny——两条对照路径全拦。同 id 修订为行为短语（"必须显式传 input"等）后：违规路径 deny、合规路径 allow。**教训入 §6：负向关键词选行为短语，不选工具名。**
5. 剩余验收缺口：召回注入在**下一轮真实任务**中出现才算 I-2 全闭环（本轮是同会话验证）。

### 已知口径缺口（已修，2026-11-09 同日）

- ~~账本无 sample_kind 字段~~ → **origin 字段已落地**：daily/verification/drill/nomination 四类；metrics 报 byOrigin + dailyCount；历史行归 untagged（不猜）。变异守卫：去掉 daily 过滤立刻红。

## 2026-11-09 · 阶段 II 提名器落地（同日追加）

### 读数（valve_nominate 真机实调，宿主重启 PID 40040→20476 后）

- 负向：真实 clis 账本（641 行）产出 1 条候选——pwsh 泛化签名 41 次，`degraded_signature: true` 如实警告"可能是无关错误攒的假重复"。human_gate 落账，生效库仍 1 条（不自动生效验证通过）。
- 正向：真实 usage 聚合（1695 行）产出 4 条候选（dsh插件开发 25/memory-manager 14/宣传片制作 11/批印坊 6），送阀**全拒 malformed_skill_evidence**——设计如此：usage 账本没有外部成败证据，提名器不编造成功率，人工补证后再提阀。
- 账本新增 5 条 origin=nomination 记录；evaluated=15，missRate=0.667。
- 测试：45 例全绿；变异 9/9 红（新增 4 条：提名阈值失效/越层提名/伪造证据级别/origin 口径失效）；仓库 npm test 退出码 0。

### 待办移交

- 泛化签名候选：人工确认前须回查 41 条原始记录是否真同一失败模式（签名塌缩教训的下游核对）。
- 正向候选补外部证据：从 dsh插件开发（engagement 最高）开始，按 memory_skill 流程结晶并跑真实任务验证。

## 周检记录（每周一 10:00 reminder 触发后追加）

（暂无）