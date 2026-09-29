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

/* ---- P2 复盘与题库接口（R01-R08） ---- */

export interface HistoryItem {
  gameId: string; seat: string; outcome: string; ratingDelta: number;
  mode: string; boardSize: number; endReason: string; winnerSeat: string | null;
  isRanked: boolean; scorePolicy: string; settledAt: number; moveCount: number; hasShare: boolean;
}
export interface ReplayMove { ply: number; seat: 'A' | 'B' | 'C'; row: number; col: number; round: number }
export interface DefenseWindow {
  threatenedSeat: string; row: number; col: number; openedAtPly: number;
  resolvedAtPly: number | null; resolvedBySeat: string | null; actions: number[]; selfResolved: boolean;
}
export interface KeyMove {
  ply: number; type: 'IMMEDIATE_WIN' | 'MISSED_WIN' | 'PREEMPTIVE_BLOCK';
  actorSeat: 'A' | 'B' | 'C'; row: number; col: number; round: number;
  eligiblePlayer: string | null; actorEligible: boolean; forbiddenCells: number;
  points: Array<{ row: number; col: number }>;
  referenceLine: Array<{ row: number; col: number }>;
  alternativeLines: Array<{ row: number; col: number; legal: boolean; winning: boolean }>;
  certainty: string; proofHorizon: number; nodes: number; wallMs: number;
  messageKey: string; args: Record<string, string | number>;
  defenseWindow: DefenseWindow | null;
}
export interface ReplayView {
  gameId: string; mySeat: string; myOutcome: string; myRatingDelta: number;
  mode: string; scorePolicy: string; settledAt: number;
  boardSize: number; moveCount: number; moves: ReplayMove[];
  status: string; winnerSeat: string | null; winLine: Array<{ row: number; col: number }> | null;
  finalHash: string; snapshotHash: string | null; snapshotRevision: number | null;
  replayOk: boolean; replayErrors: string[]; hashMatches: boolean | null;
  analysisMode: string; reviewCacheKey: string;
  keyMoves: KeyMove[]; defenseWindowCount: number; seatLabels: Record<string, string>;
  shares: Array<{ token: string; path: string; createdAt: number; expiresAt: number; revokedAt: number | null; views: number }>;
}
export interface PuzzleView {
  puzzleId: string; schema: number; acceptanceType: string; boardSize: number;
  actorSeat: 'A' | 'B' | 'C'; round: number; eligiblePlayer: string | null;
  startMoves: number; moves: Array<{ seat: 'A' | 'B' | 'C'; row: number; col: number }>;
  sourceKind: string; split: string; status: string;
  myStatus: string | null; myAttempts: number;
}
export interface AttemptResult {
  verdict: 'CORRECT' | 'INCORRECT' | 'ILLEGAL' | 'OPEN';
  duplicate: boolean; attempts: number; solved: boolean; reveal?: boolean;
  answers?: Array<{ row: number; col: number }>;
  answerCount?: number; answerSetComplete?: boolean;
  threatsBefore?: number; threatsAfter?: number; excludedByForbidden?: number;
  threatenedSeat?: string | null;
  explanation?: { messageKey: string; args: Record<string, string | number> };
}
export interface PuzzleProgress {
  solved: number; failed: number; totalAttempts: number; firstSolvedAt: number | null;
  totalPublished: number;
  wrong: Array<{ puzzleId: string; attempts: number; lastVerdict: string; updatedAt: number; acceptanceType: string | null; boardSize: number | null; round: number | null }>;
}

export const reviewApi = {
  history: (limit = 20, offset = 0) => api<{ history: HistoryItem[]; total: number; limit: number; offset: number }>('GET', `/api/history?limit=${limit}&offset=${offset}`),
  replay: (gameId: string) => api<{ replay: ReplayView }>('GET', `/api/games/${encodeURIComponent(gameId)}/replay`),
  shares: (gameId: string) => api<{ shares: Array<{ token: string; path: string; createdAt: number; expiresAt: number; revokedAt: number | null; views: number }> }>('GET', `/api/games/${encodeURIComponent(gameId)}/share`),
  share: (gameId: string) => api<{ share: { token: string; path: string; createdAt: number; expiresAt: number; ttlMs: number } }>('POST', `/api/games/${encodeURIComponent(gameId)}/share`, {}),
  revoke: (token: string) => api<{ revoked: boolean }>('DELETE', `/api/share/${encodeURIComponent(token)}`),
};

export const puzzleApi = {
  daily: (day?: string) => api<{ day: string; puzzle: PuzzleView; bank: { total: number; byType: Record<string, number>; solverVersion: string } }>('GET', `/api/puzzles/daily${day ? `?day=${day}` : ''}`),
  get: (puzzleId: string) => api<{ puzzle: PuzzleView }>('GET', `/api/puzzles/${encodeURIComponent(puzzleId)}`),
  attempt: (puzzleId: string, attemptId: string, row: number, col: number) =>
    api<AttemptResult>('POST', `/api/puzzles/${encodeURIComponent(puzzleId)}/attempt`, { attemptId, row, col }),
  progress: () => api<{ progress: PuzzleProgress }>('GET', '/api/puzzles/progress'),
};

export const authApi = {
  register: (email: string, username: string, password: string) =>
    api<{ user: PublicUser; token: string }>('POST', '/api/register', { email, username, password }),
  login: (account: string, password: string) =>
    api<{ user: PublicUser; token: string }>('POST', '/api/login', { account, password }),
  logout: () => api('POST', '/api/logout'),
  me: () => api<{ user: PublicUser }>('GET', '/api/me'),
  completeTutorial: () => api<{ user: PublicUser }>('POST', '/api/tutorial/complete'),
  ranking: (limit = 50, offset = 0) => api<{ ranking: Array<PublicUser & { wins: number; games: number; winRate: number }>; total: number }>('GET', `/api/ranking?limit=${limit}&offset=${offset}`),
  friends: () => api<{ friends: PublicUser[] }>('GET', '/api/friends'),
  invitations: () => api<{ invitations: Array<{ id: string; sender: string; senderName: string; status: string }> }>('GET', '/api/invitations'),
  invite: (toUsername: string) => api('POST', '/api/invite', { toUsername }),
  acceptInvite: (id: string) => api('POST', '/api/invite/accept', { id }),
  rejectInvite: (id: string) => api('POST', '/api/invite/reject', { id }),
};
