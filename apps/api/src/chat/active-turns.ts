type ActiveTurn = {
  conversationId: string;
  controller: AbortController;
};

const activeTurns = new Map<string, ActiveTurn>();

export function registerActiveTurn(
  turnId: string,
  conversationId: string,
  controller: AbortController,
) {
  activeTurns.set(turnId, { conversationId, controller });
}

export const removeActiveTurn = (turnId: string) => activeTurns.delete(turnId);

export function abortActiveTurn(turnId: string, reason: string) {
  const active = activeTurns.get(turnId);
  if (!active) return false;
  activeTurns.delete(turnId);
  active.controller.abort(reason);
  return true;
}

export function abortActiveTurnsForConversation(conversationId: string, reason: string) {
  for (const [turnId, active] of activeTurns) {
    if (active.conversationId !== conversationId) continue;
    activeTurns.delete(turnId);
    active.controller.abort(reason);
  }
}
