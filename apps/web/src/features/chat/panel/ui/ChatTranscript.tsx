import type { Message } from '@walden/contracts';
import { RefreshCw, X } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

type Props = {
  messages: Message[];
  renderKey(message: Message): string;
  renderMessage(message: Message, index: number): ReactNode;
};

export type MessageStatusRow = {
  key: string;
  message: string;
  alert?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
};

export function MessageStatus({ rows }: { rows: MessageStatusRow[] }) {
  return (
    <div className="action-notice">
      {rows.map((row) => (
        <p
          key={row.key}
          className={`action-notice__row${row.alert ? ' action-notice__row--alert' : ''}`}
          role={row.alert ? 'alert' : 'status'}
        >
          <span className="action-notice__message">{row.message}</span>
          {row.onRetry && (
            <button
              type="button"
              className="icon-button"
              aria-label={row.retryLabel}
              title={row.retryLabel}
              onClick={row.onRetry}
            >
              <RefreshCw size={14} aria-hidden />
            </button>
          )}
          {row.onDismiss && (
            <button
              type="button"
              className="icon-button"
              aria-label={row.dismissLabel}
              title={row.dismissLabel}
              onClick={row.onDismiss}
            >
              <X size={14} aria-hidden />
            </button>
          )}
        </p>
      ))}
    </div>
  );
}

/** Keeps the transcript order and stable response keys in one presentation boundary. */
export function ChatTranscript({ messages, renderKey, renderMessage }: Props) {
  return (
    <>
      {messages.map((message, index) => (
        <Fragment key={renderKey(message)}>{renderMessage(message, index)}</Fragment>
      ))}
    </>
  );
}
