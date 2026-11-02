/**
 * dsh-mind-system —— 心智系统聚合包的入口。
 *
 * ## 这个包做什么（以及不做什么）
 *
 * 它**不提供任何能力**。四家各自提供：
 *
 * | 插件 | 提供什么 | 少了会怎样 |
 * |---|---|---|
 * | `dsh-clis` | 因果结构判据（分类/策略/反馈/编排）+ 五工具 + 系统监督 | 判不了环/对偶/单向/嵌套；meta 退化为通用重定义 |
 * | `dsh-meta-framework` | 重定义→边界→选择→观测四层 + trace 落盘 | 失去"重新审视问题"这一手 |
 * | `dsh-memory-manager` | 五层记忆判据 + 写入准入 + 回读复核 | 记忆无判据，蒸馏回到"写进去就算" |
 * | `dsh-agent-mind` | 判断顺序常驻分节 + 按处境编排工具面 | 工具平铺，模型自行分辨该用谁 |
 *
 * 本包只做一件事：**给这四家一个共同的装载点与版本约束**。
 * 少装一家，那部分能力就不在 —— 是**降级**，不是报错。
 *
 * ## 为什么是聚合而不是合成
 *
 * 合成（把四家代码内联进一个插件）的问题：
 *
 * - 四家绑死，无法单独升级或单独关闭
 * - 体积大、审阅难、任一家改动都要重发全包
 * - 版本冲突无从解决（合成后没有"谁的版本"这个问题了）
 *
 * 聚合保留独立性，同时给使用者"一次装齐"的入口 —— 这正是本包存在的意义。
 *
 * @module dsh-mind-system
 */

/** 聚合包名。 */
export const name = 'dsh-mind-system';

/** 本包不注入任何服务（它是装载点，不是能力提供者）。 */
export const inject = [];

/**
 * 心智系统的四个成员（按装载顺序）。
 *
 * 顺序不是随意的：
 * - clis 四组件 → clis-tools（工具包 inject 依赖那四个服务）
 * - meta-framework → 依赖 clis 的分类器（ctx.get）
 * - memory-manager → 自足，放哪都行
 * - mind → 最后（需要 tools 与 systemPrompt 都已就位）
 */
export const MEMBERS = [
  'dsh-clis/classifier',
  'dsh-clis/strategy',
  'dsh-clis/feedback',
  'dsh-clis/orchestrator',
  'dsh-clis',
  'dsh-meta-framework',
  'dsh-memory-manager',
  'dsh-agent-mind',
];

/**
 * 装载：不做事。
 *
 * 成员由 `cordis.patch.yml` 里的 insert 行装载（宿主按名字解析已装 bundle）。
 * 这个入口存在是为了给宿主一个可识别的包根 —— 它导出 `name` 与 `inject`，
 * 宿主据此把它当作普通 bundle 处理。
 *
 * @param {unknown} ctx Cordis 上下文（本包不用它）。
 */
export function apply(ctx) {
  // 故意空实现：能力在四个成员里，本包只是它们的装载点。
}
