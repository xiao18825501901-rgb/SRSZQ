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
}

export type PublicUser = Pick<User, 'id' | 'username' | 'avatar' | 'onlineStatus' | 'rating'> & {
  tutorialCompleted: boolean;
  email?: string;
};
