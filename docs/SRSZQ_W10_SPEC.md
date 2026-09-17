# SRSZQ W10 Specification

## Scope

W10 fixes Online Match timeout recovery and separates AI difficulty from the five move-selection tactics. The server owns queue deadlines, match creation, seat assignment, room state, and recovery. The browser countdown is display-only.

## Matchmaking contract

Each queue entry contains a stable queue id, user id, enqueue time, deadline, and state. The first waiting human establishes the batch deadline. A 3-human batch finalizes immediately; an expired batch finalizes with one or two AI seats. Finalization atomically claims a queue generation so timer, sweeper, and a simultaneous third join cannot create duplicate rooms.

The server runs a periodic deadline sweep in addition to the one-shot wake-up. Both paths call the same idempotent finalizer. Queue removal happens before room creation. Room bindings are recorded before `game.start` is emitted.

Client messages:

- `queue.join`: enter matchmaking, or recover an existing room for the authenticated user.
- `queue.leave`: cancel only while queued.
- `queue.sync`: ask for authoritative state after the displayed deadline or after reconnect.

Server responses:

- `queue.joined`: `{ queueId, waiting, enqueuedAt, deadlineAt, serverNow, timeoutMs }`.
- `queue.state`: `{ state: 'QUEUED', ...queue metadata }`, `{ state: 'MATCHED', gameId }` followed by authoritative `game.start`, or `{ state: 'NOT_QUEUED' }`.
- `game.start`: the complete room snapshot. It may be sent repeatedly; applying it is idempotent on the client.

If a client reaches zero without a room, it displays `正在创建对局…` and requests `queue.sync` after a short grace period. Reconnect sends `queue.sync`, allowing a room whose first start message was missed to recover without rejoining a new 60-second wait.

## Matchmaking state machine

```text
CLIENT -> queue.join -> SERVER QUEUE
  SERVER QUEUE -- 3 humans --------------------> FINALIZING
  SERVER QUEUE -- deadline + 2 humans + 1 AI --> FINALIZING
  SERVER QUEUE -- deadline + 1 human + 2 AI ---> FINALIZING
  FINALIZING -> ROOM_BOUND -> game.start -> CLIENT BOARD
  CLIENT (deadline/reconnect) -> queue.sync
  queue.sync -> QUEUED | MATCHED + game.start | NOT_QUEUED
```

## AI domain contract

`AiDifficulty` is the numeric star profile `1 | 2 | 3 | 4 | 5`. `TacticId` is `'random' | 'tactical' | 'selfish' | '3ply' | 'maxn'`. They are separate types.

Every AI turn calls `selectTactic(difficulty, rng)` exactly once, then executes that tactic, validates the returned move against the shared engine legal set, and falls back to the first legal move if the tactic throws or returns an invalid decision. Fallback does not resample. Seeded or injected RNG makes tests deterministic.

The initial probability matrix is fixed unless benchmark evidence requires a small adjustment:

| Difficulty | random | tactical | selfish | 3ply | maxn |
|---|---:|---:|---:|---:|---:|
| 1 star | 45% | 22% | 15% | 10% | 8% |
| 2 star | 31% | 22% | 19% | 15% | 13% |
| 3 star | 20% | 20% | 20% | 20% | 20% |
| 4 star | 12% | 16% | 19% | 24% | 29% |
| 5 star | 8% | 12% | 16% | 25% | 39% |

The mixer never inspects the board, opponents, human identity, threats, or win chance. Existing human-protection logic may run only after tactic selection and only within tactics that support its tie-breaking policy. A selected random tactic remains random.

Public UI and room serialization expose stars only. Selected tactic, latency, validity, round, and seat are internal telemetry and benchmark fields.

## Verification gates

- Deterministic integration cases: 1H timeout, 2H timeout, 3H immediate, timeout/third-human race, reconnect, dropped `game.start` recovery, cancel, disconnect, duplicate finalization, and zero-second sync.
- 100,000 seeded selections per star profile with all tactics observed and absolute frequency error at most 1%.
- Pure-tactic and mixed-profile tournaments use the real 13x13 and 17x17 BAC engine with rotated seats and multiple fixed seeds.
- Tactic/difficulty latency reports include p50, p95, and p99; illegal decisions and fallback failures must be zero.
- Typecheck, unit, backend, WebSocket, build, local browser, platform browser, and timeout browser tests all pass before READY.
