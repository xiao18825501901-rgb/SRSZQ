import { describe, expect, it } from 'vitest';
import { isAcceptedPuzzleAttempt, puzzleAttemptFeedback } from '../puzzleFeedback';

describe('daily puzzle feedback', () => {
  it('treats only a CORRECT verdict as accepted success', () => {
    expect(isAcceptedPuzzleAttempt({ verdict: 'CORRECT' })).toBe(true);
    expect(isAcceptedPuzzleAttempt({ verdict: 'INCORRECT' })).toBe(false);
    expect(isAcceptedPuzzleAttempt({ verdict: 'ILLEGAL' })).toBe(false);
    expect(isAcceptedPuzzleAttempt({ verdict: 'OPEN' })).toBe(false);
  });

  it('never renders an unsuccessful domain result as success', () => {
    expect(puzzleAttemptFeedback(null)).toBe('idle');
    expect(puzzleAttemptFeedback({ verdict: 'CORRECT' })).toBe('success');
    expect(puzzleAttemptFeedback({ verdict: 'INCORRECT' })).toBe('error');
    expect(puzzleAttemptFeedback({ verdict: 'ILLEGAL' })).toBe('error');
    expect(puzzleAttemptFeedback({ verdict: 'OPEN' })).toBe('error');
  });
});
