import * as Dialog from '@radix-ui/react-dialog';

export function DeleteThreadDialog({
  title,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  title: string;
  pending: boolean;
  error?: string;
  onCancel(): void;
  onConfirm(): void;
}) {
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
          aria-describedby="delete-thread-description"
        >
          <Dialog.Title>Delete thread?</Dialog.Title>
          <Dialog.Description id="delete-thread-description">
            “{title || 'Untitled thread'}”, its messages, and its note will be permanently deleted.
          </Dialog.Description>
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
              {pending ? 'Deleting…' : 'Delete thread'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
