import type { ChatEvent } from '@walden/contracts';

import { upsertActivity } from '../../chat-panel-utils';
import type { ChatDisplayState } from '../state/use-chat-display-state';
import type { ChatTurnState } from '../state/use-chat-turn';

type LiveEventState = {
  display: Pick<
    ChatDisplayState,
    | 'setStatus'
    | 'setLiveContextCompacted'
    | 'setReasoning'
    | 'setLiveTools'
    | 'setLiveSources'
    | 'setLiveAnnotations'
  >;
  turn: Pick<ChatTurnState, 'streamTarget' | 'displayStreamTarget'>;
};

export function handleLiveChatEvent({ display, turn }: LiveEventState, event: ChatEvent): boolean {
  switch (event.type) {
    case 'text':
      turn.displayStreamTarget(turn.streamTarget.current + event.text);
      return true;
    case 'status':
      display.setStatus(event.text);
      return true;
    case 'context-compacted':
      display.setLiveContextCompacted(true);
      return true;
    case 'reasoning':
      display.setReasoning((current) => current + event.text);
      return true;
    case 'tool':
      display.setLiveTools((current) => upsertActivity(current, event.tool));
      return true;
    case 'source':
      display.setLiveSources((current) => upsertActivity(current, event.source));
      return true;
    case 'annotation':
      display.setLiveAnnotations((current) => [...current, event.annotation]);
      return true;
    default:
      return false;
  }
}
