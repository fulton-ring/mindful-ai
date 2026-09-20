import type { Annotation } from '@walden/contracts';

export type ContextualActionId =
  | 'deeper'
  | 'check_evidence'
  | 'challenge'
  | 'test_assumption'
  | 'explore_alternatives'
  | 'explore_question'
  | 'rephrase'
  | 'weigh_tradeoffs'
  | 'plan_next_steps'
  | 'simplify'
  | 'give_example'
  | 'capture';

export type ContextualAction = Readonly<{ id: ContextualActionId; label: string }>;

const action = (id: ContextualActionId, label: string): ContextualAction => ({ id, label });
const capture = action('capture', 'Add to note');
const manualActions = [action('deeper', 'Dig deeper'), action('challenge', 'Challenge'), capture];

const actionsByKind = {
  fact: [action('deeper', 'Dig deeper'), action('check_evidence', 'Check evidence'), capture],
  claim: [action('check_evidence', 'Check evidence'), action('challenge', 'Challenge'), capture],
  assumption: [
    action('test_assumption', 'Test assumption'),
    action('explore_alternatives', 'Explore alternatives'),
    capture,
  ],
  question: [
    action('explore_question', 'Explore question'),
    action('rephrase', 'Rephrase'),
    capture,
  ],
  decision: [
    action('weigh_tradeoffs', 'Weigh trade-offs'),
    action('plan_next_steps', 'Plan next steps'),
    capture,
  ],
  explanation: [action('simplify', 'Simplify'), action('give_example', 'Give an example'), capture],
} satisfies Partial<Record<Annotation['kind'], readonly ContextualAction[]>>;

export function contextualActions(kind?: Annotation['kind']): readonly ContextualAction[] {
  return kind && kind in actionsByKind
    ? actionsByKind[kind as keyof typeof actionsByKind]
    : manualActions;
}

export function contextualActionRequest(
  actionId: string,
  quote: string,
): { prompt: string; intent: 'message' | 'challenge' } | null {
  const quoted = `“${quote}”`;
  switch (actionId) {
    case 'deeper':
      return { prompt: `Dive deeper into: ${quoted}`, intent: 'message' };
    case 'check_evidence':
      return {
        prompt: `Examine what supports this statement and its limits. If no sources are available, say so rather than implying verification: ${quoted}`,
        intent: 'message',
      };
    case 'challenge':
      return { prompt: `Challenge: ${quoted}`, intent: 'challenge' };
    case 'test_assumption':
      return {
        prompt: `Test this assumption. Explain what would make it hold or fail: ${quoted}`,
        intent: 'message',
      };
    case 'explore_alternatives':
      return { prompt: `Explore credible alternatives to: ${quoted}`, intent: 'message' };
    case 'explore_question':
      return { prompt: `Explore this question and its implications: ${quoted}`, intent: 'message' };
    case 'rephrase':
      return { prompt: `Rephrase this question more clearly: ${quoted}`, intent: 'message' };
    case 'weigh_tradeoffs':
      return { prompt: `Weigh the trade-offs behind this decision: ${quoted}`, intent: 'message' };
    case 'plan_next_steps':
      return {
        prompt: `Plan practical next steps for this decision: ${quoted}`,
        intent: 'message',
      };
    case 'simplify':
      return { prompt: `Explain this more simply: ${quoted}`, intent: 'message' };
    case 'give_example':
      return { prompt: `Give a concrete example of: ${quoted}`, intent: 'message' };
    default:
      return null;
  }
}
