/** SRSZQ backend 共享模型 */

export interface User {
  id: string;
  email: string;
  username: string;
  avatar: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
  tutorialCompleted: boolean;
  onlineStatus: 'online' | 'offline' | 'playing' | 'matching';
  rating: number;
  /** P4：管理角色由受控 CLI 授予；只有 ADMIN 能进管理接口。 */
  role: 'USER' | 'ADMIN';
  /**
   * 增量 C：provisional = 一键创建的临时账号（还没有设置昵称/密码）。
   * 老库补列时默认 'CLAIMED'，所以既有正式用户天然就是已领取状态，不需要单独迁移脚本。
   */
  accountType: 'PROVISIONAL' | 'CLAIMED';
  /** 领取（设置昵称+密码）的时间；未领取为 null。 */
  claimedAt: number | null;
  /** 最近一次活动时间（会话校验时刷新），用于闲置临时账号清理队列。 */
  lastSeenAt: number;
}

export type PublicUser = Pick<User, 'id' | 'username' | 'avatar' | 'onlineStatus' | 'rating' | 'role'> & {
  tutorialCompleted: boolean;
  email?: string;
  /** 前端据此提示“完善账号”，并据此不把临时账号当正式账号展示。 */
  provisional?: boolean;
};
