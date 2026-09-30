/**
 * 增量 C 的真实生产缺陷留下的护栏：**迟到的 401 不能清掉刚建立的会话**。
 *
 * 现场（线上真实浏览器，网络轨迹）：
 *   1. 首屏挂载时 Platform 会调一次 /api/me；此时一键账号的 cookie 还没建立 -> 401；
 *   2. 同一时刻用户点了「创建账号并开始」-> quick-start 201 -> 写入会话与本地用户；
 *   3. 第 1 步那个**迟到的 401** 回来，refresh() 里的 clearAuth() 把第 2 步刚建好的账号清掉了，
 *      应用于是跳回 #/auth，用户看到的是“没登录”。
 * 本地因为 API 太快、顺序不同，一直没复现 —— 是线上端到端验收抓出来的。
 *
 * 判定规则很窄：只有当“这次 refresh 开始时的世代”仍然是当前世代时才允许清；
 * 中途发生过任何一次成功的登录/建号（世代 +1），这个错误就必须被丢弃。
 */

/** 会话世代：每次成功登录/建号/领取 +1。 */
export function nextGeneration(current: number): number {
  return current + 1;
}

/** 这个错误看起来像“未授权/被拒”吗？（只有这类才可能触发清理） */
export function isAuthRejection(message: string): boolean {
  return /unauthorized|HTTP 40[13]/.test(message);
}

/**
 * 迟到的鉴权失败是否应该清本地会话？
 * - 不是鉴权类错误（网络抖动等）：不清；
 * - 期间已经建立过新会话（世代变了）：不清（否则会清掉刚建好的账号）；
 * - 其余情况：清。
 */
export function shouldClearSessionOnError(genAtStart: number, genNow: number, message: string): boolean {
  if (!isAuthRejection(message)) return false;
  return genAtStart === genNow;
}
