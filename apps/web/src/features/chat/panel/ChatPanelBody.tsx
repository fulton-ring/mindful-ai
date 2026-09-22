import { ChatPanelView } from './ChatPanelView';
import type { ChatPanelProps } from './chat-panel-types';
import { useChatPanelController } from './use-chat-panel-controller';
import { useChatPanelViewModel } from './use-chat-panel-view-model';

export type { ChatPanelProps as Props } from './chat-panel-types';
export { upsertActivity } from './chat-panel-utils';

export function ChatPanelBody(props: ChatPanelProps) {
  const controller = useChatPanelController(props);
  const model = useChatPanelViewModel(props, controller);
  return <ChatPanelView props={props} controller={controller} model={model} />;
}
