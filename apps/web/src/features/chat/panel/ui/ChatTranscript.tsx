import type { WaldenUIMessage } from '@walden/contracts';
import { RefreshCw, X } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';

type Props = {
  messages: WaldenUIMessage[];
  renderMessage(message: WaldenUIMessage, index: number): ReactNode;
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

/** Keeps the transcript order in one presentation boundary; a reply keeps its turn id as key. */
export function ChatTranscript({ messages, renderMessage }: Props) {
  return (
    <>
      {messages.map((message, index) => (
        <Fragment key={message.id}>{renderMessage(message, index)}</Fragment>
      ))}
    </>
  );
}
