import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import type { MessageBudget, Persona } from '@walden/contracts';
import { Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';
import { failureDetails, track } from '../../lib/telemetry';
import { AccountSettings } from './AccountSettings';

const TABS = ['account', 'usage', 'personas'] as const;
type Tab = (typeof TABS)[number];
export function SettingsPanel({
  open = true,
  onClose,
  personas,
  onEditPersona,
  onDeletePersona,
  onCreatePersona,
}: {
  open?: boolean;
  personas: Persona[];
  onEditPersona(persona: Persona): void;
  onDeletePersona(persona: Persona): Promise<void>;
  onCreatePersona(): void;
  onClose(): void;
}) {
  const [deletingPersona, setDeletingPersona] = useState<string | null>(null);
  const [personaError, setPersonaError] = useState('');
  const [tab, setTab] = useState<Tab>('account');
  return (
    <Dialog.Root open={open} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="modal settings-modal"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // The persona editor owns focus while Settings is temporarily hidden.
            if (!open) event.preventDefault();
          }}
        >
          <header className="settings-header">
            <Dialog.Title>Settings</Dialog.Title>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label="Close settings">
                <X />
              </button>
            </Dialog.Close>
          </header>
          <div className="settings-layout">
            <nav aria-label="Settings sections">
              {TABS.map((item) => (
                <button
                  key={item}
                  className={tab === item ? 'active' : ''}
                  onClick={() => {
                    setTab(item);
                    track('settings_section_opened', { action: item });
                  }}
                >
                  {item}
                </button>
              ))}
              <UnavailableConnectorsTab />
            </nav>
            <main>
              {tab === 'personas' && (
                <section className="persona-settings">
                  <div className="persona-settings-heading">
                    <h2>Personas</h2>
                    <button className="text-button" onClick={onCreatePersona}>
                      <Plus size={16} /> New persona
                    </button>
                  </div>
                  {personaError && (
                    <p role="alert" className="inline-error">
                      {personaError}
                    </p>
                  )}
                  <div className="persona-list">
                    {personas.map((persona) => (
                      <div className="persona-row" key={persona.id}>
                        <div className="persona-description">
                          <h3>{persona.name}</h3>
                          <p>{persona.prompt}</p>
                        </div>
                        <div className="persona-actions">
                          <button
                            className="icon-button"
                            aria-label={`Edit ${persona.name}`}
                            title="Edit"
                            onClick={() => onEditPersona(persona)}
                          >
                            <Pencil size={16} />
                          </button>
                          <button
                            className="icon-button danger"
                            aria-label={`Delete ${persona.name}`}
                            title={personas.length <= 1 ? 'Keep at least one persona' : 'Delete'}
                            disabled={deletingPersona !== null || personas.length <= 1}
                            onClick={async () => {
                              setPersonaError('');
                              setDeletingPersona(persona.id);
                              try {
                                await onDeletePersona(persona);
                              } catch (error) {
                                track('account_action_failed', {
                                  action: 'delete_persona',
                                  ...failureDetails(error),
                                });
                                setPersonaError(
                                  error instanceof Error
                                    ? error.message
                                    : 'Could not delete persona.',
                                );
                              } finally {
                                setDeletingPersona(null);
                              }
                            }}
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                    ))}
                    {personas.length === 0 && <p className="muted">No personas yet.</p>}
                  </div>
                </section>
              )}
              {tab === 'account' && <AccountSettings />}
              {tab === 'usage' && <Usage />}
            </main>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function UnavailableConnectorsTab() {
  return (
    <button
      type="button"
      aria-disabled="true"
      title="Coming soon"
      onClick={() =>
        track('action_blocked', { action: 'open_connectors', failure_code: 'coming_soon' })
      }
    >
      Connectors
    </button>
  );
}

function Usage() {
  const query = useQuery({ queryKey: ['usage'], queryFn: api.usage });
  if (query.isLoading)
    return (
      <section>
        <h2>Usage</h2>
        <p>Loading measured usage…</p>
      </section>
    );
  if (query.error)
    return (
      <section>
        <h2>Usage</h2>
        <div className="inline-error">Usage is unavailable: {query.error.message}</div>
      </section>
    );
  const value = query.data!;
  return (
    <section>
      <h2>Usage</h2>
      <MessageBudgetMeter budget={value.budget} />
      <dl>
        <div>
          <dt>Messages sent</dt>
          <dd>{value.messagesSent.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Most used persona</dt>
          <dd>{value.favoritePersona ?? 'No clear favourite yet'}</dd>
        </div>
      </dl>
    </section>
  );
}

function resetTime(iso: string) {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === new Date().toDateString()
    ? time
    : `${at.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

function MessageBudgetMeter({ budget }: { budget: MessageBudget }) {
  const remaining = Math.max(0, budget.limit - budget.used);
  const window = budget.windowHours === 1 ? 'hour' : `${budget.windowHours} hours`;
  return (
    <div className="message-budget">
      <p>
        <strong>{remaining}</strong> of {budget.limit} message points left
      </p>
      <div
        className="meter"
        role="meter"
        aria-label="Message points left"
        aria-valuemin={0}
        aria-valuemax={budget.limit}
        aria-valuenow={remaining}
      >
        <span style={{ width: `${(remaining / budget.limit) * 100}%` }} />
      </div>
      <p className="muted">
        {budget.nextResetAt && budget.fullResetAt
          ? `Points come back ${window} after each message: the next at ${resetTime(budget.nextResetAt)}, all by ${resetTime(budget.fullResetAt)}.`
          : `Each message uses points for ${window}; heavier models use more.`}
      </p>
    </div>
  );
}
