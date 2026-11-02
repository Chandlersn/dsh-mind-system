# 发布说明 · 心智系统 monorepo

> 仓库：<https://github.com/Chandlersn/dsh-mind-system>
> 日期：2026-11-02

## 已完成

**GitHub**：`Chandlersn/dsh-mind-system`（public，main 分支）

四家合成一个仓库，`packages/` 下各自独立：

| 包 | 目录 | 说明 |
|---|---|---|
| `dsh-agent-mind` | `packages/dsh-agent-mind` | 调度层：判断顺序分节 + 按处境重排工具面 + 命中率回归与采样 |
| `dsh-clis` | `packages/dsh-clis` | 因果结构判据 + 系统监督 + 介入漏判分母 |
| `dsh-meta-framework` | `packages/dsh-meta-framework` | 重定义 → 边界 → 选择 → 观测 |
| `dsh-memory-manager` | `packages/dsh-memory-manager` | 五层记忆判据 + 写入前拒绝 + 落盘后回读复核 |
| `dsh-mind-system` | `packages/dsh-mind-system` | 聚合包：装载四家（唯一入口形态） |

**安装形态**（别人怎么用）：

```bash
dsh plugin --profile web add dsh-mind-system
```

装完重启宿主。聚合包是四家唯一的装载入口，**不要**再单独装其中一家（会双装载）。

**本机已切到 monorepo 为唯一真源**：profile 的 junction 全部指向 `packages/` 下对应目录 ——
改代码与发仓库是同一处。

## 三个设计决定（都有实测依据）

**1. monorepo 而非四个仓**：四家是一套心智系统的四个部件，走同一版本节奏。分散在四个仓时，"这四家能一起用吗"没有单一答案。

**2. 聚合包装载四家，且四家不在 `bundles` 里**。三种形态各验证一次：

| 形态 | 结果 |
|---|---|
| 聚合包不装载四家 | 单独装 = 四家全都不在（`clis_probe` 消失） |
| 聚合包装载 + 四家也在 `bundles` | 双装载，**聚合包自己被挤掉**（user_plugins 14，mind-system 消失） |
| **聚合包装载 + 四家不在 `bundles`** | **唯一入口、零重复**（采用） |

**3. `dsh-mind` → `dsh-agent-mind`**：npm 上 `dsh-mind` 已被他人占用（"心智·数字组织"，维护者 wjthqyj）。目录名未改（profile 的 link 依赖它），只改包名。

## 待办

- [ ] **删两个空壳仓**（`dsh-agent-mind` / `dsh-meta-framework`）：当前 GitHub token 缺 `delete_repo` scope，API 删不了（403）。**在网页上删即可** —— 内容已全部并入 monorepo。
- [ ] **npm 发布**：本轮不发布（需 npm token）。发布前跑 `node packages/dsh-mind-system/scripts/publish-check.mjs`，它验四组：装载点可解析 / 依赖声明完整 / 唯一入口形态 / 版本区间对得上。
- [ ] **CLIS 的同步路径**：`packages/dsh-clis` 放的是**发布产物**（来自 `D:\个人开发\CLIS` 的 `dist-package`）。CLIS 的真正源码在那个独立仓（多包 workspace：`@causal-layers/clis-*`）。改 CLIS 源码后要重新 `bundle.mjs` → `package.mjs` → 同步到 `packages/dsh-clis`。这条链已踩过坑（见「拷贝式打包不重建中间产物」那条法）。

## 发布前的验证命令

```bash
node packages/dsh-mind-system/scripts/publish-check.mjs   # 聚合包发布前检查
node packages/dsh-agent-mind/test/*.test.js               # 调度层 53 例
node packages/dsh-agent-mind/scripts/verify-assembly.mjs   # 真实 cordis 装配验证
```
