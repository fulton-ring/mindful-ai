import * as Dialog from '@radix-ui/react-dialog';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../lib/api';

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
      <div className="privacy-choice">
        <label htmlFor={notice ? 'privacy-notice-choice' : 'privacy-settings-choice'}>
          <strong>Help improve Walden</strong>
          <span>Share new messages and replies</span>
        </label>
        <input
          id={notice ? 'privacy-notice-choice' : 'privacy-settings-choice'}
          type="checkbox"
          aria-label="Help improve Walden"
          checked={notice ? initialChoice : (preference.data?.enabled ?? true)}
          disabled={!preference.data || save.isPending}
          onChange={(event) =>
            notice ? setInitialChoice(event.target.checked) : save.mutate(event.target.checked)
          }
        />
      </div>
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
          className="modal privacy-modal"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <div className="privacy-heading">
            <Dialog.Title>Conversation privacy</Dialog.Title>
            <Dialog.Description>
              You choose whether to share conversations to help improve Walden.
            </Dialog.Description>
          </div>
          <p className="privacy-summary">
            Sharing lets Fulton Ring review new messages and replies through PostHog to diagnose
            issues and improve Walden. We don’t use them to train AI models.
          </p>
          {control}
          <p className="privacy-change-note">
            Sharing is optional. You can change this anytime in Settings → Account.
          </p>
          <footer className="privacy-footer">
            <nav aria-label="Privacy and terms">
              <a href="/privacy" target="_blank" rel="noreferrer">
                Privacy Policy
              </a>
              <a href="/terms" target="_blank" rel="noreferrer">
                Terms of Service
              </a>
            </nav>
            <button
              className="privacy-continue"
              disabled={save.isPending}
              onClick={() => save.mutate(initialChoice)}
            >
              {save.isPending ? 'Saving…' : 'Continue'}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
