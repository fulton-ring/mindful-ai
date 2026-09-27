import type { ChatEvent } from '@walden/contracts';

import type { ChatDisplayState } from '../state/use-chat-display-state';
import type { ChatTurnState } from '../state/use-chat-turn';

type LiveEventState = {
  display: Pick<ChatDisplayState, 'dispatchLiveTurn'>;
  turn: Pick<ChatTurnState, 'streamTarget' | 'displayStreamTarget'>;
};

export function handleLiveChatEvent({ display, turn }: LiveEventState, event: ChatEvent): boolean {
  const dispatch = display.dispatchLiveTurn;
  switch (event.type) {
    case 'reset':
      turn.displayStreamTarget('');
      dispatch({ type: 'reset' });
      return true;
    case 'text-snapshot':
      turn.displayStreamTarget(event.text);
      dispatch({ type: 'reasoning', text: event.reasoning });
      return true;
    case 'text':
      turn.displayStreamTarget(turn.streamTarget.current + event.text);
      return true;
    case 'status':
      dispatch({ type: 'status', text: event.text });
      return true;
    case 'context-compacted':
      dispatch({ type: 'context-compacted' });
      return true;
    case 'reasoning':
      dispatch({ type: 'reasoning', text: event.text, append: true });
      return true;
    case 'tool':
      dispatch({ type: 'tool', tool: event.tool });
      return true;
    case 'source':
      dispatch({ type: 'source', source: event.source });
      return true;
    case 'annotation':
      dispatch({ type: 'annotation', annotation: event.annotation });
      return true;
    default:
      return false;
  }
}
