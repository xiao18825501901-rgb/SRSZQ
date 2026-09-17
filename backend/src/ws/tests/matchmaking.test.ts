import { describe, expect, it } from 'vitest';
import { MatchmakingQueue } from '../matchmaking';

describe('server-authoritative matchmaking deadlines', () => {
  it('claims 1H at its deadline and only once', () => {
    const queue = new MatchmakingQueue(60_000);
    const joined = queue.join('u1', 's1', 1_000);
    expect(joined.deadlineAt).toBe(61_000);
    expect(queue.claimEligible(60_999)).toBeNull();
    const claim = queue.claimEligible(61_000);
    expect(claim?.entries.map((entry) => entry.userId)).toEqual(['u1']);
    expect(claim?.aiCount).toBe(2);
    expect(queue.claimEligible(61_000)).toBeNull();
  });

  it('claims 2H at the oldest deadline and fills one AI', () => {
    const queue = new MatchmakingQueue(60_000);
    queue.join('u1', 's1', 1_000);
    queue.join('u2', 's2', 20_000);
    const claim = queue.claimEligible(61_000);
    expect(claim?.entries.map((entry) => entry.userId)).toEqual(['u1', 'u2']);
    expect(claim?.aiCount).toBe(1);
  });

  it('claims 3H immediately and cannot duplicate on the timeout race', () => {
    const queue = new MatchmakingQueue(60_000);
    queue.join('u1', 's1', 1_000);
    queue.join('u2', 's2', 2_000);
    queue.join('u3', 's3', 61_000);
    const immediate = queue.claimEligible(61_000);
    const timeoutRace = queue.claimEligible(61_000);
    expect(immediate?.entries).toHaveLength(3);
    expect(immediate?.aiCount).toBe(0);
    expect(timeoutRace).toBeNull();
  });

  it('keeps the original deadline when a socket reconnects', () => {
    const queue = new MatchmakingQueue(60_000);
    const first = queue.join('u1', 'old-socket', 1_000);
    const reconnected = queue.join('u1', 'new-socket', 30_000);
    expect(reconnected.queueId).toBe(first.queueId);
    expect(reconnected.enqueuedAt).toBe(1_000);
    expect(reconnected.deadlineAt).toBe(61_000);
    expect(queue.snapshotFor('u1')?.socketId).toBe('new-socket');
  });

  it('cancellation and disconnect remove the entry without ghost matching', () => {
    const queue = new MatchmakingQueue(100);
    queue.join('cancelled', 's1', 0);
    expect(queue.leave('cancelled')).toBeTruthy();
    expect(queue.claimEligible(100)).toBeNull();
    queue.join('disconnected', 's2', 200);
    expect(queue.leave('disconnected')).toBeTruthy();
    expect(queue.claimEligible(300)).toBeNull();
  });
});
