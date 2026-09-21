import * as Dialog from '@radix-ui/react-dialog';

export function DeleteThreadDialog({
  title,
  mode,
  target = 'thread',
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  mode: 'archive' | 'delete';
  target?: 'thread' | 'note';
  pending: boolean;
  error?: string;
  onCancel(): void;
  onConfirm(): void;
}) {
  const archive = mode === 'archive';
  const description = archive
    ? `“${title || 'Untitled thread'}” and its messages will be permanently deleted. The note will remain in Notes.`
    : target === 'note'
      ? `“${title || 'Untitled note'}” will be permanently deleted.`
      : `“${title || 'Untitled thread'}”, its messages, and its note will be permanently deleted.`;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !pending) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="modal delete-thread-dialog"
          role="alertdialog"
          aria-describedby="thread-removal-description"
        >
          <Dialog.Title>
            {archive ? 'Archive thread?' : target === 'note' ? 'Delete note?' : 'Delete thread?'}
          </Dialog.Title>
          <Dialog.Description id="thread-removal-description">{description}</Dialog.Description>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <div className="button-row">
            <button type="button" disabled={pending} onClick={onCancel}>
              Cancel
            </button>
            <button type="button" className="danger" disabled={pending} onClick={onConfirm}>
              {pending
                ? archive
                  ? 'Archiving…'
                  : 'Deleting…'
                : archive
                  ? 'Archive thread'
                  : target === 'note'
                    ? 'Delete everything'
                    : 'Delete thread'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
