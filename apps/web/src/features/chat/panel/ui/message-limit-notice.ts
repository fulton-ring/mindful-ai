import { type MessageBudget, modelWeight, PERSONA_MODELS, type Persona } from '@walden/contracts';
import { resetTime } from '../../../../lib/reset-time';

/**
 * Why the selected persona cannot send until the budget resets, or null. Shown
 * only once no reply is running, so it appears after the last reply lands.
 */
export function messageLimitNotice(
  budget: MessageBudget | null | undefined,
  persona: Pick<Persona, 'name' | 'model'> | undefined,
  sending: boolean,
  now = Date.now(),
): string | null {
  if (sending || !budget?.resetsAt || Date.parse(budget.resetsAt) <= now) return null;
  const remaining = budget.limit - budget.used;
  const weight = modelWeight(persona?.model ?? PERSONA_MODELS[0].id);
  if (remaining >= weight) return null;
  const at = resetTime(budget.resetsAt);
  return remaining <= 0
    ? `You've reached your message limit. It resets at ${at}.`
    : `Not enough messages left for ${persona?.name ?? 'this persona'}. Choose another persona, or wait until ${at}.`;
}
