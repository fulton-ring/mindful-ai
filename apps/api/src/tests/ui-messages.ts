import type { WaldenMessageMetadata, WaldenUIMessage } from '@walden/contracts';

/** A stored-shape message whose only content is one text part. */
export function textMessage(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  metadata: Partial<WaldenMessageMetadata> = {},
  parts: WaldenUIMessage['parts'] = [],
): WaldenUIMessage {
  return {
    id,
    role,
    parts: [{ type: 'text', text }, ...parts],
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', ...metadata },
  };
}

export const interruptedMessage = (id: string, text: string) =>
  textMessage(id, 'assistant', text, { status: 'interrupted' });

export const completeMessage = (id: string, text: string, metadata = {}) =>
  textMessage(id, 'assistant', text, { status: 'complete', ...metadata });

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * A SQL literal for the `ui_message` column, for raw INSERT fixtures:
 * `INSERT INTO messages (...,ui_message) VALUES (...,${uiMessageSql('m1','assistant','Hi')})`.
 */
export const uiMessageSql = (
  id: string,
  role: 'user' | 'assistant',
  text: string,
  metadata: Partial<WaldenMessageMetadata> = {},
) => quote(JSON.stringify(textMessage(id, role, text, metadata)));
