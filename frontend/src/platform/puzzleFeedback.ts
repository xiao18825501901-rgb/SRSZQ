import type { AttemptResult } from '../api';

type PuzzleAttemptVerdict = Pick<AttemptResult, 'verdict'>;
export type PuzzleAttemptFeedback = 'idle' | 'success' | 'error';

/** A successful HTTP response is not enough: the server verdict must be CORRECT. */
export function isAcceptedPuzzleAttempt(result: PuzzleAttemptVerdict): boolean {
  return result.verdict === 'CORRECT';
}

export function puzzleAttemptFeedback(result: PuzzleAttemptVerdict | null): PuzzleAttemptFeedback {
  if (!result) return 'idle';
  return isAcceptedPuzzleAttempt(result) ? 'success' : 'error';
}
