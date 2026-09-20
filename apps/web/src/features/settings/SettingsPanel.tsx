import * as Dialog from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import type { AppConfig, Persona } from '@walden/contracts';
import { ArrowUpRight, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../lib/api';

type Tab = 'account' | 'billing' | 'usage' | 'connections' | 'appearance' | 'personas';
export function SettingsPanel({
  config,
  theme,
  onTheme,
  onClose,
  personas,
  onEditPersona,
  onDeletePersona,
  onCreatePersona,
}: {
  config: AppConfig;
  personas: Persona[];
  onEditPersona(persona: Persona): void;
  onDeletePersona(persona: Persona): Promise<void>;
  onCreatePersona(): void;
  theme: 'light' | 'dark';
  onTheme(value: 'light' | 'dark'): void;
  onClose(): void;
}) {
  const [deletingPersona, setDeletingPersona] = useState<string | null>(null);
  const [personaError, setPersonaError] = useState('');
  const [tab, setTab] = useState<Tab>('account');
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content className="modal settings-modal" aria-describedby={undefined}>
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
              {(
                [
                  'account',
                  ...(config.billingEnabled ? ['billing'] : []),
                  'usage',
                  'connections',
                  'appearance',
                  'personas',
                ] as Tab[]
              ).map((item) => (
                <button
                  key={item}
                  className={tab === item ? 'active' : ''}
                  onClick={() => setTab(item)}
                >
                  {item}
                </button>
              ))}
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
                            title="Delete"
                            disabled={deletingPersona !== null}
                            onClick={async () => {
                              setPersonaError('');
                              setDeletingPersona(persona.id);
                              try {
                                await onDeletePersona(persona);
                              } catch (error) {
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
              {tab === 'account' && <Account config={config} />}
              {tab === 'billing' && config.billingEnabled && <Billing config={config} />}
              {tab === 'billing' && !config.billingEnabled && (
                <p>Billing is disabled during testing.</p>
              )}
              {tab === 'usage' && <Usage />}
              {tab === 'connections' && <Connections />}
              {tab === 'appearance' && <Appearance theme={theme} onTheme={onTheme} />}
            </main>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Account({ config }: { config: AppConfig }) {
  return (
    <section>
      <h2>Account</h2>
      <p>
        Your notes belong to your signed-in account. Thread history expires seven days after your
        last message.
      </p>
      {config.authConfigured && (
        <p className="muted">
          Use the profile button at the bottom of the sidebar to manage your account or sign out.
        </p>
      )}
    </section>
  );
}
function Billing({ config }: { config: AppConfig }) {
  async function open(kind: 'checkout' | 'portal') {
    try {
      const { url } = await api.billing(kind);
      location.assign(url);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Billing is unavailable.');
    }
  }
  return (
    <section>
      <h2>Plan & billing</h2>
      <p>Billing is currently disabled. Assistant usage is unlimited.</p>
      {config.billingConfigured ? (
        <div className="button-row">
          <button className="primary" onClick={() => open('checkout')}>
            Choose Personal
          </button>
          <button onClick={() => open('portal')}>
            Manage billing <ArrowUpRight size={15} />
          </button>
        </div>
      ) : (
        <div className="notice">
          <strong>Billing is not available yet</strong>
          <p>Stripe has not been configured for this environment.</p>
        </div>
      )}
    </section>
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
      <p>
        {value.used} assistant turns. No usage limit. Count resets{' '}
        {new Date(value.resetsAt).toLocaleDateString()}.
      </p>
      <dl>
        <div>
          <dt>Messages sent</dt>
          <dd>{value.messagesSent.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Most used persona</dt>
          <dd>{value.favoritePersona ?? 'No clear favourite yet'}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{value.provider || 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{value.model || 'Unavailable'}</dd>
        </div>
        <div>
          <dt>Input tokens</dt>
          <dd>{value.inputTokens.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Output tokens</dt>
          <dd>{value.outputTokens.toLocaleString()}</dd>
        </div>
      </dl>
      <p className="muted">
        Token counts describe usage. They are not an energy or emissions estimate.
      </p>
    </section>
  );
}
function Connections() {
  const query = useQuery({ queryKey: ['connections'], queryFn: api.connections });
  return (
    <section>
      <h2>Connections</h2>
      <p>
        Connections let the assistant read from explicitly configured tools. Each action remains
        subject to your approval.
      </p>
      {query.isLoading && <p>Checking connections…</p>}
      {query.error && (
        <div className="inline-error">Connections are unavailable: {query.error.message}</div>
      )}
      {query.data?.length === 0 && <div className="empty-box">No connections are configured.</div>}
      {query.data?.map((connection) => (
        <div className="connection" key={connection.id}>
          <div>
            <strong>{connection.name}</strong>
            <p>{connection.description}</p>
          </div>
          <span>{connection.status}</span>
        </div>
      ))}
    </section>
  );
}
function Appearance({
  theme,
  onTheme,
}: {
  theme: 'light' | 'dark';
  onTheme(value: 'light' | 'dark'): void;
}) {
  return (
    <section>
      <h2>Appearance</h2>
      <fieldset>
        <legend>Color theme</legend>
        <label className="radio">
          <input type="radio" checked={theme === 'light'} onChange={() => onTheme('light')} /> Light
        </label>
        <label className="radio">
          <input type="radio" checked={theme === 'dark'} onChange={() => onTheme('dark')} /> Dark
        </label>
      </fieldset>
    </section>
  );
}
