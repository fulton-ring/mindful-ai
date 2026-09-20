export type LearningFeedback = { right: string; correction: string; nextStep: string };

export function formatLearningFeedback(value: LearningFeedback): string {
  const right = value.right.trim() || 'You engaged with the target.';
  const correction = value.correction.trim() || 'No correction needed.';
  const next = value.nextStep.trim() || 'Apply the idea once in your own words.';
  return `Right: ${right}\nCorrection: ${correction}\nNext: ${next}`;
}
