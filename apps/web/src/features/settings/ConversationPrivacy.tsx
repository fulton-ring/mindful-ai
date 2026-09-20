import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';

export const conversationPrivacyCopy =
  'Share new messages and visible replies with Fulton Ring and PostHog to diagnose problems, review response quality, and develop and improve Walden. Authorized team members may review them. This does not include training AI models. Content is retained in PostHog for up to 30 days; diagnostic metadata is retained separately. Replies may repeat information from your notes or earlier messages. You can turn sharing off at any time; doing so does not delete previously collected data.';

export function ConversationPrivacy({ notice = false }: { notice?: boolean }) {
  const client = useQueryClient();
  const preference = useQuery({ queryKey: ['account-privacy'], queryFn: api.accountPrivacy });
  const [initialChoice, setInitialChoice] = useState(true);
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.setAccountPrivacy(enabled, preference.data!.version),
    onSuccess: (data) => client.setQueryData(['account-privacy'], data),
  });
  if (notice && (!preference.data || preference.data.acknowledged)) return null;
  const control = (
    <>
      <p>{conversationPrivacyCopy}</p>
      <label className="settings-row">
        Help improve Walden
        <input
          type="checkbox"
          aria-label="Help improve Walden"
          checked={notice ? initialChoice : (preference.data?.enabled ?? true)}
          disabled={!preference.data || save.isPending}
          onChange={(event) =>
            notice ? setInitialChoice(event.target.checked) : save.mutate(event.target.checked)
          }
        />
      </label>
      {preference.isError && (
        <p role="alert">
          Could not load your preference.{' '}
          <button onClick={() => void preference.refetch()}>Retry</button>
        </p>
      )}
      {save.isError && <p role="alert">Could not save your preference. Please try again.</p>}
    </>
  );
  if (!notice)
    return (
      <section>
        <h3>Conversation sharing</h3>
        {control}
      </section>
    );
  return (
    <Dialog.Root open>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="modal"
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <Dialog.Title>Your conversation privacy</Dialog.Title>
          {control}
          <p>
            Sharing starts with new exchanges after you continue. Existing history is not uploaded.
            Basic server diagnostics continue when sharing is off.
          </p>
          <p>
            <a href="/privacy" target="_blank" rel="noreferrer">
              Privacy Policy
            </a>{' '}
            ·{' '}
            <a href="/terms" target="_blank" rel="noreferrer">
              Terms of Service
            </a>
          </p>
          <button disabled={save.isPending} onClick={() => save.mutate(initialChoice)}>
            {save.isPending ? 'Saving…' : 'Continue'}
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
