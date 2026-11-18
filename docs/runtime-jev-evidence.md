# Jev 判别客户端：隔离证据与外部依赖

日期：2026-11-17。隔离工作树：`D:\个人开发\dsh-execution-runtime`，分支：`feat/dual-loop-runtime`。运行环境：Node.js `v22.23.3`。本次没有写活动原仓库、配置 profile、安装依赖、构建合成包或提交。

## 验收结论

| 项目 | 本次结果 | 证据边界 |
| :--- | :--- | :--- |
| DL-0.2 真实提供者门 | 外部依赖未验证 | 专用 Jev 端点、模型、凭据环境均缺失，真实请求数为 0；没有真实鉴权、成功响应、服务错误或延迟证据 |
| DL-1.3 协议与规则降级子项 | 初步隔离已验 | 首轮31项通过，主开发补充非法UTF-8响应后32项通过；只证明客户端在这些反例中的行为 |
| DR-04 协议反例与降级子项 | 初步隔离已验 | 缺项、重复、未知、错误类型、越界及非有限评分拒绝；失联不隐式选择动作；明确安全规则才返回唯一动作 |
| 生产选择质量、校准与延迟目标 | 未验证 | 未采真实任务样本；不将 noul 当作成功概率或校准置信度，不声称达到 P95 目标 |

阶段状态由主开发更新总计划；本报告不自动改变原计划 F/N 或其他 DL 节点状态。

## 协议依据

读取并核对的实际源码：

- [SAG models.rs](<D:/个人开发/SAG-wiki/SAG-Wiki/core/src/models.rs>)：252–313 行组装 `model`、字符串 `state` 和对象 `questions`；345–397 行校验对象 `answers`、候选完整性、`type:noul` 及 `[0,1]` 数值。
- [SAG decisions.rs](<D:/个人开发/SAG-wiki/SAG-Wiki/core/src/models/decisions.rs>)：19–54 行区分原生 systemone 与官方 Decisions 适配；58–120 行展示另一协议需要显式转换，不能直接冒充原生评分。
- [融合计划](DUAL-LOOP-INTEGRATION-PLAN.md)：第 5.2 节的 DecisionResult，以及 DL-0.2、DL-1.3、DR-04 的分门验收要求。

本实现只提供原生 `systemone-noul-v1`。端点必须给出完整 URL，不自动追加路径、不根据域名切换协议。请求为一次批量 `POST`：

```json
{
  "model": "explicit-model",
  "state": "serialized task state",
  "questions": {
    "candidate-id": {
      "type": "noul",
      "instructions": {
        "question": "English scoring criterion",
        "candidate": { "candidateId": "candidate-id" }
      },
      "criteria": { "true": "English positive criterion", "false": "English negative criterion" }
    }
  }
}
```

返回必须有对象 `answers`，且候选 ID 与请求集合完全相同，每项含 `type:"noul"` 和有限数值 `noul`，范围含端点 0 与 1。原始 JSON 在 `JSON.parse` 前扫描重复键，覆盖顶层、候选键、评分字段及 Unicode 转义后相同的键。未知、缺失、重复、数组代替对象、错误类型、字符串/布尔/null/无穷/越界评分均拒绝。

## 导出与调用契约

实现：[decision-client.js](../packages/dsh-execution-runtime/src/decision-client.js)。测试：[decision-client.test.js](../packages/dsh-execution-runtime/test/decision-client.test.js)。

- `SYSTEMONE_PROTOCOL_VERSION`：`systemone-noul-v1`。
- `DecisionError`：错误有稳定的 `code`；不把服务端正文、URL 或底层错误原因带入公开错误。
- `buildSystemoneRequest({model,state,candidates})`：`state` 为字符串或对象；候选数组非空，`candidateId` 为唯一非空字符串。返回原生批量请求。
- `parseSystemoneResponse(raw,candidates)`：必须传原始 JSON 字符串，完成重复键、结构及完整性验证后返回 `Record<candidateId,number>`。
- `new DecisionClient({provider,endpoint,model,auth,timeoutMs,maxResponseBytes?})`：供应商名称、完整 HTTP(S) 端点、模型、鉴权和超时均显式给出。鉴权为 `{type:"none"}` 或 `{type:"bearer",token}`。超时整数范围为 1–120000 毫秒。响应大小默认 1 MiB，可显式设为 1 字节至 16 MiB。URL 禁止内嵌账号密码、查询串和片段，重定向拒绝。
- `client.query({state,candidates,signal?})`：只查询评分，返回 `{scores,provider,model,protocolVersion,elapsedMs}`，失败抛出错误。父级取消和超时覆盖响应头等待与响应体读取，完成时移除监听器和定时器。不自动重试、不隐式降级。
- `selectDecision(scoring,{version,minScore,minMargin})`：调用方显式提供策略版本与 `[0,1]` 阈值。最高分低于阈值或两个最高分差不足时弃权；并列最高分始终弃权，即使 `minMargin:0`。唯一候选的分差为 `null`。返回计划中 DecisionResult 的所有必需字段，并附 `decisionSource:"provider"`、`policyVersion`、`highestScore`、`scoreMargin`。`confidence:null`、`confidenceSource:"unavailable"`，无分布字段。
- `client.decide({...request,policy})`：查询后调用选择策略；策略无效时在请求前拒绝。
- `selectUniqueRuleFallback({candidates,rule,admitted})`：仅当候选恰好一个、`effect:"read"`、`admitted:true`，并且规则的 `candidateId/recipeId/recipeVersion` 与候选 ID 和 `source.recipeId/source.version` 完全匹配且规则有非空 `version` 时，返回该候选并标记 `decisionSource:"rules"`。没有匹配规则、多个候选、未准入或写动作都弃权。评分为空、置信度不可得，禁止捏造评分。该函数消费调用方已经完成的准入结果，不自行授予权限。空候选列表属于无效输入，由候选生成层处理 `plan_gap`。

错误码：`decision_config_error`、`decision_protocol_error`、`decision_http_error`、`decision_transport_error`、`decision_timeout`、`decision_cancelled`。协议/网络失败保持错误身份；调用方可明确选择适用的规则降级，不能把任意异常吞掉再选最高优先级动作。

## 已运行验证

```sh
node --test packages/dsh-execution-runtime/test/decision-client.test.js
```

首次结果：31 tests，31 pass，0 fail，0 cancelled，0 skipped，进程退出码 0。主开发复核时补充fatal UTF-8解码与非法字节反例，最终协议套件32/32通过，整包68/68通过，退出码均为0。本地 HTTP 服务使用回环地址和随机端口；包含：批量请求形状与鉴权、正常独立分数、19 种协议错误、边界与特殊候选键、重复输入、策略弃权、唯一规则绑定、连接失败、响应头/响应体超时、取消关闭连接、预取消/坏策略零请求、HTTP 错误与重定向不泄漏、响应大小限制和配置校验。

取消测试除检查客户端错误码，还观测服务端连接关闭；坏策略和预取消测试观测服务端请求计数为 0。fixture 中的鉴权字符串仅为测试常量，没有读取真实密钥。fixture 耗时不当作 Jev 延迟样本。

## 真实探针

脚本：[probe-jev.mjs](../packages/dsh-execution-runtime/scripts/probe-jev.mjs)。只读取这一专用环境命名空间：

- `DSH_JEV_ENDPOINT`：明确的完整原生 systemone 端点。
- `DSH_JEV_MODEL`：该端点的模型名称。
- `DSH_JEV_API_KEY`：明确用于该 Jev 提供者的凭据。不能用其他提供者的 key 代替。
- `DSH_JEV_TIMEOUT_MS`：可选，默认 10000，受客户端超时上限约束。
- `DSH_JEV_PROBE_SAMPLES`：可选，默认 3，整数范围 1–100。

三项必需配置齐备才发起真实请求，不扫描其他环境、用户凭据文件或服务配置。脚本只输出状态、稳定错误码、次数和延迟样本，不输出凭据、端点、模型值、原始服务响应或底层错误。所有候选都是被评分的数据描述，不执行其中的工具。

```sh
node packages/dsh-execution-runtime/scripts/probe-jev.mjs
```

本次实际输出：`status:external_dependency_not_verified`，缺少上述三个必需环境，`liveRequests:0`，`fixtureTestsProveApi:false`。探针进程退出码 0 表示明确完成配置缺失检查，不表示真实 API 验证成功。没有检查或替用其他供应商凭据。

后续需由拥有明确 Jev 配置的环境运行探针，留存成功批量评分和延迟样本；若需将 DL-0.2 整体转为真实已验，还需真实服务的鉴权、错误与超时证据。本脚本的少量成功样本不能替代计划要求的任务级性能评估。
