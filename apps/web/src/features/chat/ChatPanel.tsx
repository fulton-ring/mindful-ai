import type { ComponentProps } from 'react';

import { ChatPanelBody } from './ChatPanelBody';

export { upsertActivity } from './ChatPanelBody';

export function ChatPanel(props: ComponentProps<typeof ChatPanelBody>) {
  return <ChatPanelBody {...props} />;
}
