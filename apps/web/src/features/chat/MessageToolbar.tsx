import { Check, Copy, Highlighter, NotebookPen, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '../../components/ui/tooltip';
import { MessageStatus, type MessageStatusRow } from './ChatTranscript';

type Props = {
  sending: boolean;
  proposalPending: boolean;
  highlighting: boolean;
  copied: boolean;
  proposalNotice?: {
    message: string;
    retryable: boolean;
    onRetry?: () => void;
  };
  highlightFailure?: { message?: string; onRetry(): void; onDismiss(): void };
  onDismissNotice(): void;
  onPropose(): void;
  onHighlight(): void;
  onRegenerate(): void;
  onCopy(): void;
};

export function MessageToolbar(props: Props) {
  const rows = buildRows(props);
  return (
    <div className="message-actions">
      <ToolbarButtons {...props} />
      {rows.length > 0 && <MessageStatus rows={rows} />}
    </div>
  );
}

function buildRows({ highlighting, proposalNotice, highlightFailure, onDismissNotice }: Props) {
  const rows: MessageStatusRow[] = [];
  if (highlighting) rows.push({ key: 'highlighting', message: 'Adding highlights…' });
  else if (highlightFailure)
    rows.push({
      key: 'highlight-failure',
      alert: true,
      message: highlightFailure.message ?? 'Highlights could not be generated. Please try again.',
      onRetry: highlightFailure.onRetry,
      retryLabel: 'Retry highlights',
      onDismiss: highlightFailure.onDismiss,
      dismissLabel: 'Dismiss highlight error',
    });
  if (proposalNotice)
    rows.push({
      key: 'note-notice',
      alert: proposalNotice.retryable,
      message: proposalNotice.message,
      ...(proposalNotice.retryable && proposalNotice.onRetry
        ? { onRetry: proposalNotice.onRetry, retryLabel: 'Retry note proposal' }
        : {}),
      onDismiss: onDismissNotice,
      dismissLabel: 'Dismiss note proposal status',
    });
  return rows;
}

function ToolbarButtons({
  sending,
  proposalPending,
  highlighting,
  copied,
  onPropose,
  onHighlight,
  onRegenerate,
  onCopy,
}: Props) {
  return (
    <div className="message-toolbar" aria-label="Response actions">
      <TooltipProvider delayDuration={250}>
        <ToolbarButton
          label="Propose note edit"
          disabled={sending || proposalPending}
          onClick={onPropose}
        >
          <NotebookPen aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          label="Highlight response"
          tooltipLabel="Highlight"
          disabled={highlighting}
          onClick={onHighlight}
        >
          <Highlighter aria-hidden />
        </ToolbarButton>
        <RegenerateToolbarButton disabled={sending} onClick={onRegenerate} />
        <ToolbarButton
          label={copied ? 'Copied response' : 'Copy response'}
          tooltipLabel={copied ? 'Copied' : 'Copy Markdown'}
          onClick={onCopy}
        >
          {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
        </ToolbarButton>
      </TooltipProvider>
    </div>
  );
}

function ToolbarButton({
  label,
  tooltipLabel = label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tooltipLabel?: string;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="icon-button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent className="annotation-tooltip">{tooltipLabel}</TooltipContent>
    </Tooltip>
  );
}

function RegenerateToolbarButton({ disabled, onClick }: { disabled: boolean; onClick(): void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="toolbar-tooltip-trigger" tabIndex={-1}>
          <button
            type="button"
            className="icon-button"
            aria-label="Regenerate response"
            disabled={disabled}
            onClick={onClick}
          >
            <RefreshCw aria-hidden />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent className="annotation-tooltip">Regenerate from here</TooltipContent>
    </Tooltip>
  );
}
