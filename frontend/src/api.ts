/** SRSZQ 前端 API 客户端（后端 http://127.0.0.1:8080） */

export const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://127.0.0.1:8080';
export const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? 'ws://127.0.0.1:8081/ws';

const TOKEN_KEY = 'srszq_token';
const USER_KEY = 'srszq_user';

export interface PublicUser {
  id: string;
  username: string;
  avatar: string;
  email?: string;
  tutorialCompleted: boolean;
  onlineStatus: string;
  rating: number;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setAuth(token: string, user: PublicUser): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}
export function clearAuth(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}
export function getCachedUser(): PublicUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as PublicUser) : null;
  } catch {
    return null;
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(API_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: any = {};
  try {
    data = await res.json();
  } catch {
    /* 空响应 */
  }
  if (!res.ok && !data.ok) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return { status: res.status, data };
}

export const authApi = {
  register: (email: string, username: string, password: string) =>
    api<{ user: PublicUser; token: string }>('POST', '/api/register', { email, username, password }),
  login: (account: string, password: string) =>
    api<{ user: PublicUser; token: string }>('POST', '/api/login', { account, password }),
  logout: () => api('POST', '/api/logout'),
  me: () => api<{ user: PublicUser }>('GET', '/api/me'),
  completeTutorial: () => api<{ user: PublicUser }>('POST', '/api/tutorial/complete'),
  ranking: (limit = 20) => api<{ ranking: Array<PublicUser & { wins: number; games: number; winRate: number }> }>('GET', `/api/ranking?limit=${limit}`),
  friends: () => api<{ friends: PublicUser[] }>('GET', '/api/friends'),
  invitations: () => api<{ invitations: Array<{ id: string; sender: string; senderName: string; status: string }> }>('GET', '/api/invitations'),
  invite: (toUsername: string) => api('POST', '/api/invite', { toUsername }),
  acceptInvite: (id: string) => api('POST', '/api/invite/accept', { id }),
  rejectInvite: (id: string) => api('POST', '/api/invite/reject', { id }),
};
