# DesignSystem — SRSZQ.com 视觉设计系统

> 目标质感：Premium Strategy Game Platform（参考 shadcn/ui、Aceternity、Magic UI 等设计思想，
> 以自定义 CSS 令牌 + 轻量 framer-motion 落地，未复制任何项目）。
> 实现位置：`frontend/src/styles/global.css`（:root 令牌 + `.ds-*`）、`frontend/src/ui.tsx`（原语组件）。

## 1. 设计令牌

### 色彩
| 令牌 | 值 | 用途 |
|---|---|---|
| --ds-bg-0 / 1 / 2 | #0a0e14 / #0f141d / #151b26 | 页面背景分层 |
| --ds-surface(-strong) | rgba(255,255,255,.04/.07) | 卡片/表面 |
| --ds-border(-strong) | rgba(255,255,255,.10/.18) | 描边 |
| --ds-text / -2 / -3 | #eef2f7 / #b9c2cf / #7e8898 | 文本层级 |
| --ds-accent / -2 | #7c5cff / #b79cff | 主强调（在线/选中/glow） |
| --ds-ok / warn / danger | #3ddc84 / #ffb224 / #ff5c5c | 状态 |
| --ds-a/b/c | #e5484d / #30a46c / #f7f7f7 | 玩家三色（与引擎一致） |
| body 背景 | 径向渐变 #1a1433 → #0a0e14 | 顶部紫晕，深空基底 |

### 圆角 / 阴影 / 动效
- 圆角：--ds-r-sm 8 / md 12 / lg 18 / xl 26
- 阴影：sm（普通抬升）、md（浮层/卡片）、glow（accent 辉光，用于主按钮与强调卡）
- 动效：--ds-dur-1 120ms / 2 220ms / 3 380ms；--ds-ease cubic-bezier(.22,.61,.36,1)

### 字体与排版
- --ds-font：Segoe UI + 系统 + PingFang/雅黑（中英混排一致）
- 标题体系：页面标题 26px（.ds-h2）、区块眉题 .ds-title（15px 大写加宽字距、text-3）
- Hero h1 clamp(40px,7vw,76px) 800 weight；tagline 字距 6px 300 weight

## 2. 原语组件（frontend/src/ui.tsx）
- `Btn`：variant default/primary/ghost/danger × size small/default/big；hover 抬升 + 辉光
- `Card`：`.ds-card`（渐变表面 + 描边 + 圆角 lg）；`hoverable` 抬升 + 阴影过渡
- `StatusBadge / StatusBadgeView`：状态徽章 online/playing/matching/offline（含中文文案）
- `Stars`：AI ★1-5（永远不显示真实档位）
- `PageMotion`：页面进入过渡（fade+y，280ms easeOut）

## 3. 布局模式
- 页面宽度：内容 980–1180px；Landing 全宽 hero（clamp 大字 + 轨道光晕 orbs）
- **Lobby Feature Cards**：`grid repeat(auto-fit, minmax(250px,1fr))`，每卡 ≥240px 高、
  占屏 ≥20-25%；icon + 标题 + 描述 + meta + CTA；hover translateY(-5px)（framer whileHover）
- 玻璃导航：`sticky` + backdrop blur 14px + 半透明底（.glass-nav）
- 游戏内对局区沿用竞技深色棋盘视觉（未改动引擎/棋盘组件语义）

## 4. 动效规范（克制原则）
- 页面/区块进入：fade + 8-16px 位移，≤380ms
- 卡片 hover：scale/位移 ≤5px + 辉光；不做弹跳/循环特效
- 棋盘落子：仅“最后一步”棋子播放 ds-drop（0.28s scale+落位），避免整盘闪烁
- 排队等待：Searching players… + 倒计时进度条（渐隐于游戏开始）
- 禁止：过度花哨、干扰可读性的动画

## 5. 组件化与复用
平台页统一走 ui.tsx 原语；游戏内组件（Board/Cell/PlayerCard/Modal 等）保持独立职责；
类名以 `ds-`（设计系统）与 `pf-`/现有语义类区分；新增 UI 一律引用令牌，禁止硬编码新色值。
