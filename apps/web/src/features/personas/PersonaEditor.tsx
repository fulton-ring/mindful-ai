import * as Dialog from '@radix-ui/react-dialog';
import type { Persona } from '@walden/contracts';
import { ChevronDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { PERSONA_ICONS, personaIconKey } from './PersonaIcon';

export function PersonaEditor({
  persona,
  onSave,
  onDelete,
  onClose,
}: {
  persona: Persona;
  onSave(value: Persona): void | Promise<void>;
  onDelete?(): void | Promise<void>;
  onClose(): void;
}) {
  const [draft, setDraft] = useState(persona);
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(persona);
    setPending(null);
    setError('');
  }, [persona]);

  const valid = draft.name.trim().length > 0 && draft.prompt.trim().length > 0;
  const busy = pending !== null;
  async function save() {
    if (!valid || busy) return;
    setError('');
    setPending('save');
    try {
      await onSave(draft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The persona could not be saved.');
      setPending(null);
    }
  }
  async function remove() {
    if (!onDelete || busy) return;
    setError('');
    setPending('delete');
    try {
      await onDelete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The persona could not be deleted.');
      setPending(null);
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="modal"
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            returnFocus?.focus();
          }}
        >
          <header>
            <Dialog.Title asChild>
              <h2>{persona.id ? 'Edit persona' : 'New persona'}</h2>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label="Close" disabled={busy}>
                <X />
              </button>
            </Dialog.Close>
          </header>
          <fieldset className="persona-icon-picker" disabled={busy}>
            <legend>Icon</legend>
            <div>
              {Object.entries(PERSONA_ICONS).map(([key, { label, component: Icon }]) => (
                <button
                  key={key}
                  type="button"
                  className="icon-button"
                  aria-label={`${label} icon`}
                  title={label}
                  aria-pressed={personaIconKey(draft) === key}
                  onClick={() => setDraft({ ...draft, icon: key as Persona['icon'] })}
                >
                  <Icon size={20} aria-hidden />
                </button>
              ))}
            </div>
          </fieldset>
          <label htmlFor="persona-name">
            Name
            <input
              id="persona-name"
              value={draft.name}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>
          <label htmlFor="persona-prompt">
            Instructions
            <textarea
              id="persona-prompt"
              rows={6}
              value={draft.prompt}
              disabled={busy}
              onChange={(event) => setDraft({ ...draft, prompt: event.target.value })}
            />
          </label>
          <label htmlFor="persona-model">
            Model
            <Select value="gemma-4" disabled>
              <SelectTrigger id="persona-model" aria-label="Model">
                <SelectValue />
                <ChevronDown size={14} aria-hidden />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="gemma-4">Gemma 4</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <div className="field-grid">
            <label>
              Tone
              <Select
                value={draft.tone}
                onValueChange={(value: Persona['tone']) => setDraft({ ...draft, tone: value })}
                disabled={busy}
              >
                <SelectTrigger aria-label="Tone">
                  <SelectValue />
                  <ChevronDown size={14} aria-hidden />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="warm">Warm</SelectItem>
                  <SelectItem value="neutral">Neutral</SelectItem>
                  <SelectItem value="direct">Direct</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label>
              Brevity
              <Select
                value={draft.brevity}
                onValueChange={(value: Persona['brevity']) =>
                  setDraft({ ...draft, brevity: value })
                }
                disabled={busy}
              >
                <SelectTrigger aria-label="Brevity">
                  <SelectValue />
                  <ChevronDown size={14} aria-hidden />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="brief">Brief</SelectItem>
                  <SelectItem value="balanced">Balanced</SelectItem>
                  <SelectItem value="detailed">Detailed</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label>
              Challenge
              <Select
                value={draft.challenge}
                onValueChange={(value: Persona['challenge']) =>
                  setDraft({ ...draft, challenge: value })
                }
                disabled={busy}
              >
                <SelectTrigger aria-label="Challenge">
                  <SelectValue />
                  <ChevronDown size={14} aria-hidden />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="gentle">Gentle</SelectItem>
                  <SelectItem value="balanced">Balanced</SelectItem>
                  <SelectItem value="direct">Direct</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </div>
          {error && (
            <p className="inline-error" role="alert">
              {error}
            </p>
          )}
          <footer>
            {onDelete && persona.id && (
              <button className="danger" onClick={() => void remove()} disabled={busy}>
                {pending === 'delete' ? 'Deleting…' : 'Delete persona'}
              </button>
            )}
            <span />
            <Dialog.Close asChild>
              <button disabled={busy}>Cancel</button>
            </Dialog.Close>
            <button className="primary" onClick={() => void save()} disabled={!valid || busy}>
              {pending === 'save' ? 'Saving…' : 'Save persona'}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
