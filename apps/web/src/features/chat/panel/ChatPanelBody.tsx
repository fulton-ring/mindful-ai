import type { ChatPanelProps } from './chat-panel-types';
import { useChatPanelController } from './hooks/controller/use-chat-panel-controller';
import { ChatPanelView } from './ui/ChatPanelView';
import { useChatPanelViewModel } from './ui/use-chat-panel-view-model';

export type { ChatPanelProps as Props } from './chat-panel-types';

export function ChatPanelBody(props: ChatPanelProps) {
  const controller = useChatPanelController(props);
  const model = useChatPanelViewModel(controller);
  return <ChatPanelView props={props} controller={controller} model={model} />;
}
