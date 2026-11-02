# DSH 心智系统

**DeepSeek Harness** 上的一套心智系统 —— 让 agent 知道"遇到什么问题先问什么"，并且**能自己发现自己错了**。

不是四个工具的清单，是一条链：

```
用户的问题
   ↓
① dsh-agent-mind      判断顺序常驻提示 + 按处境把该看的工具推到眼前
   ↓                 （"什么时候用谁"被显式化，不再靠 agent 从平铺的工具表里猜）
② dsh-clis            判因果结构：环 / 对偶 / 单向 / 嵌套
   ↓                 （反复无效时，给尺子而不是给更多方案）
③ dsh-meta-framework  重新审视问题本身：重定义 → 边界 → 选择 → 观测
   ↓                 （"真问题可能不是字面问题"）
④ dsh-memory-manager  沉淀：五层判据守写入，判据反哺上一轮
                     （器 → 术 → 法 → 道，每层有边界有反面）
```

## 仓库

<https://github.com/Chandlersn/dsh-mind-system> —— 四家合成一个仓库（`packages/` 下），
npm 上仍是五个独立包。

## 安装

```bash
dsh plugin --profile web add dsh-mind-system
```

装完**重启宿主**（server 半边需要重新装载）。

聚合包 `dsh-mind-system` **装载四个成员**，是它们唯一的装载入口。
别再单独装其中一家 —— 那家会被装载两次（同 id 覆盖，仍能工作但行为取决于装载顺序）。

### 只想用其中一家的能力

从聚合包的 `bundles` 里移除其余即可；或者直接单独装那一家
（此时不要装聚合包）。

| 少装 | 后果（是降级，不是报错） |
|---|---|
| `dsh-clis` | 判不了环/对偶/单向；meta 退化为通用重定义；系统监督消失 |
| `dsh-meta-framework` | 失去"重新审视问题"这一手 |
| `dsh-memory-manager` | 记忆写入无判据把关，蒸馏退回"写进去就算" |
| `dsh-agent-mind` | 工具平铺在提示里，agent 得自己从描述里分辨该用谁 |

## 四个包

| 包 | 做什么 |
|---|---|
| [`dsh-agent-mind`](packages/dsh-agent-mind) | 调度层：判断顺序 + 按处境编排工具面 + 命中率可测 |
| [`dsh-clis`](packages/dsh-clis) | 判因果结构 + 系统监督（只报增量）+ 介入带漏判分母 |
| [`dsh-meta-framework`](packages/dsh-meta-framework) | 重定义 → 边界 → 选择 → 观测，四层 + trace |
| [`dsh-memory-manager`](packages/dsh-memory-manager) | 五层记忆：道/法/术/器 + 写入前拒绝 + 落盘后回读复核 |

## 这套系统的三个特点

**判据是代码，不是文档。** 五层各有硬判据：法要 ≥2 个**无关**来源域、道要 ≥5 条法萃取、
每层必须写出"何时不成立"。写入前拒绝，落盘后从磁盘回读复核，回执带 `selfCheck`。

**调度可测。** 处境判定有命中率回归（含一批**留白样本**专门检验泛化），
真实使用另有采样趋势（只存输入哈希，不存原文）。

**闭环靠数据，不靠排期。** 每轮迭代由"被放过的失败"或"读数为假"触发 ——
本仓库里三个病灶（漏判分母缺失、签名塌缩、跨重启去重丢失）都是这样冒出来的，
不是排期表上划掉的任务。

## 开发

```bash
npm install                    # 工作区依赖
npm test                       # 调度层测试 + 发布前检查
node packages/dsh-mind-system/scripts/publish-check.mjs   # 发布前验证
```

各包可独立 `npm publish`（monorepo 只是源码在一起，npm 上是五个独立包）。

## 许可

MIT
