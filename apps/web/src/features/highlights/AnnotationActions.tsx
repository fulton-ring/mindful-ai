import { type Annotation, HIGHLIGHT_COLORS, type MessageHighlight } from '@walden/contracts';
import { X } from 'lucide-react';
import type { RefObject } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '../../components/ui/popover';
import { type ContextualActionId, contextualActions } from './contextual-actions';
import type { AnnotationMenu } from './use-annotation-selection';

function kindLabel(kind: Annotation['kind']) {
  return kind[0].toUpperCase() + kind.slice(1);
}

export type AnnotationActionStatus = {
  pending: boolean;
  message?: string;
  alert?: boolean;
  onRetry?(): void;
  onDismiss?(): void;
};

type AnnotationActionsProps = {
  active: boolean;
  menu: AnnotationMenu | null;
  toolbar: RefObject<HTMLDivElement | null>;
  virtualAnchor: RefObject<{ getBoundingClientRect: () => DOMRect }>;
  returnFocus: RefObject<HTMLElement | null>;
  onDismiss(clearSelection?: boolean): void;
  onAction(action: ContextualActionId): void;
  onCreateHighlight?(color: MessageHighlight['color']): void;
  onUpdateHighlight?(value: MessageHighlight): void;
  highlightPending: boolean;
  highlightError: string;
  onClearHighlightError(): void;
  actionStatus?: AnnotationActionStatus | null;
};

function actionLabel(menu: AnnotationMenu | null) {
  if (menu?.kind) return `Actions for ${kindLabel(menu.kind)} annotation`;
  if (menu?.highlight) return 'Actions for Highlight';
  return 'Actions for selected text';
}

function menuLabel(menu: AnnotationMenu | null) {
  if (menu?.kind) return kindLabel(menu.kind);
  if (menu?.highlight) return 'Highlight';
  return 'Selected text';
}

function HighlightSwatches({
  menu,
  pending,
  onCreate,
  onUpdate,
}: {
  menu: AnnotationMenu;
  pending: boolean;
  onCreate?(color: MessageHighlight['color']): void;
  onUpdate?(value: MessageHighlight): void;
}) {
  if (!menu.sourceRange || menu.kind || !onCreate) return null;
  if (menu.highlight && !onUpdate) return null;
  const recolor = Boolean(menu.highlight && !menu.kind);
  return (
    <div className="selection-actions-highlights" aria-label="Highlight colors">
      {HIGHLIGHT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          className={`highlight-swatch highlight-swatch-${color}`}
          aria-label={`${recolor ? 'Recolor highlight' : 'Highlight'} ${color}`}
          disabled={pending}
          onClick={() => {
            if (recolor) onUpdate?.({ ...menu.highlight!, color });
            else onCreate(color);
          }}
        />
      ))}
    </div>
  );
}

function ActionStatus({ status }: { status: AnnotationActionStatus }) {
  if (!status.pending && !status.message) return null;
  return (
    <div
      role={status.alert ? 'alert' : 'status'}
      aria-live="polite"
      className={`selection-actions-status${status.alert ? ' selection-actions-status-alert' : ''}`}
    >
      <span>{status.pending ? 'Adding to note…' : status.message}</span>
      {!status.pending && status.onRetry && (
        <button type="button" onClick={status.onRetry}>
          Try again
        </button>
      )}
      {!status.pending && status.onDismiss && (
        <button type="button" onClick={status.onDismiss}>
          Dismiss
        </button>
      )}
    </div>
  );
}

export function AnnotationActions({
  active,
  menu,
  toolbar,
  virtualAnchor,
  returnFocus,
  onDismiss,
  onAction,
  onCreateHighlight,
  onUpdateHighlight,
  highlightPending,
  highlightError,
  onClearHighlightError,
  actionStatus,
}: AnnotationActionsProps) {
  return (
    <Popover open={active && Boolean(menu)} onOpenChange={(open) => !open && onDismiss()}>
      <PopoverAnchor virtualRef={virtualAnchor} />
      <PopoverContent
        ref={toolbar}
        className="selection-actions"
        role="toolbar"
        aria-label={actionLabel(menu)}
        side="bottom"
        align="start"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => event.stopPropagation()}
        onEscapeKeyDown={() => {
          returnFocus.current?.focus();
          returnFocus.current = null;
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocus.current) {
            toolbar.current
              ?.querySelector<HTMLButtonElement>('.selection-actions-buttons button')
              ?.focus();
          }
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
          returnFocus.current = null;
        }}
      >
        <div className="selection-actions-header">
          <span className="selection-actions-label">{menuLabel(menu)}</span>
          <button
            className="selection-actions-close"
            type="button"
            aria-label="Close selection actions"
            onClick={() => onDismiss(true)}
          >
            <X size={12} aria-hidden />
          </button>
        </div>
        {menu && (
          <HighlightSwatches
            menu={menu}
            pending={highlightPending}
            onCreate={onCreateHighlight}
            onUpdate={onUpdateHighlight}
          />
        )}
        {highlightError && (
          <div role="alert" className="selection-actions-error">
            {highlightError}
            <button type="button" onClick={onClearHighlightError}>
              Dismiss
            </button>
          </div>
        )}
        {actionStatus && <ActionStatus status={actionStatus} />}
        <div className="selection-actions-buttons">
          {contextualActions(menu?.kind).map((action) => (
            <button key={action.id} type="button" onClick={() => onAction(action.id)}>
              {action.label}
            </button>
          ))}
        </div>
        {menu?.highlight && onUpdateHighlight && (
          <button
            type="button"
            className="selection-actions-remove"
            disabled={highlightPending}
            onClick={() => onUpdateHighlight({ ...menu.highlight!, color: null })}
          >
            Remove highlight
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}
