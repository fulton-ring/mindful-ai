import type { ComponentProps } from 'react';

import { ChatPanelBody } from './panel/ChatPanelBody';

export { upsertActivity } from './panel/ChatPanelBody';

export function ChatPanel(props: ComponentProps<typeof ChatPanelBody>) {
  return <ChatPanelBody {...props} />;
}
