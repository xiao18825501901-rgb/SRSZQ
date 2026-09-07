export type QueueEntryState = 'QUEUED' | 'PROCESSING';

export interface MatchmakingEntry {
  queueId: string;
  userId: string;
  socketId: string;
  enqueuedAt: number;
  deadlineAt: number;
  state: QueueEntryState;
  generation: number;
}

export interface MatchmakingClaim {
  queueId: string;
  generation: number;
  entries: MatchmakingEntry[];
  aiCount: number;
}

/** Pure synchronous state machine. Removing entries is the atomic claim. */
export class MatchmakingQueue {
  private readonly timeoutMs: number;
  private entries: MatchmakingEntry[] = [];
  private generation = 0;

  constructor(timeoutMs: number) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('matchmaking timeout must be positive');
    this.timeoutMs = timeoutMs;
  }

  join(userId: string, socketId: string, now: number): MatchmakingEntry {
    const existing = this.entries.find((entry) => entry.userId === userId);
    if (existing) {
      existing.socketId = socketId;
      return { ...existing };
    }
    if (this.entries.length === 0) this.generation++;
    const entry: MatchmakingEntry = {
      queueId: `queue-${this.generation}`,
      userId,
      socketId,
      enqueuedAt: now,
      deadlineAt: now + this.timeoutMs,
      state: 'QUEUED',
      generation: this.generation,
    };
    this.entries.push(entry);
    return { ...entry };
  }

  leave(userId: string): MatchmakingEntry | null {
    const index = this.entries.findIndex((entry) => entry.userId === userId);
    if (index < 0) return null;
    return { ...this.entries.splice(index, 1)[0] };
  }

  snapshotFor(userId: string): MatchmakingEntry | null {
    const entry = this.entries.find((candidate) => candidate.userId === userId);
    return entry ? { ...entry } : null;
  }

  get size(): number { return this.entries.length; }

  get nextDeadlineAt(): number | null {
    if (this.entries.length === 0) return null;
    return Math.min(...this.entries.map((entry) => entry.deadlineAt));
  }

  claimEligible(now: number): MatchmakingClaim | null {
    if (this.entries.length === 0) return null;
    const deadlineReached = this.nextDeadlineAt !== null && now >= this.nextDeadlineAt;
    if (this.entries.length < 3 && !deadlineReached) return null;
    const claimed = this.entries.splice(0, Math.min(3, this.entries.length))
      .map((entry) => ({ ...entry, state: 'PROCESSING' as const }));
    return {
      queueId: claimed[0].queueId,
      generation: claimed[0].generation,
      entries: claimed,
      aiCount: 3 - claimed.length,
    };
  }
}
