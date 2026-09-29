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
}

export type PublicUser = Pick<User, 'id' | 'username' | 'avatar' | 'onlineStatus' | 'rating' | 'role'> & {
  tutorialCompleted: boolean;
  email?: string;
};
