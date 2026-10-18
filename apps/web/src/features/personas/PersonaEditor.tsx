import * as Dialog from '@radix-ui/react-dialog';
import { type InferenceModel, type Persona, type PublicInferenceConfig } from '@walden/contracts';
import { ChevronDown, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../components/ui/select';
import { useInferenceConfig } from '../../lib/runtime-config';
import { PERSONA_ICONS, personaIconKey } from './PersonaIcon';

type Props = {
  persona: Persona;
  onSave(value: Persona): void | Promise<void>;
  onDelete?(): void | Promise<void>;
  onClose(): void;
};

export function PersonaEditor({ persona, onSave, onDelete, onClose }: Props) {
  const [draft, setDraft] = useState(persona);
  const catalog = useInferenceConfig();
  const models = catalog.models.filter(chatModel);
  const unavailable = Boolean(draft.model && !models.some(({ id }) => id === draft.model));
  const [returnFocus] = useState(() => document.activeElement as HTMLElement | null);
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setDraft(persona);
    setPending(null);
    setError('');
  }, [persona]);
  const busy = pending !== null;
  const valid = Boolean(draft.name.trim() && draft.prompt.trim() && !unavailable);
  return (
    <PersonaDialog
      title={persona.id ? 'Edit persona' : 'New persona'}
      busy={busy}
      onClose={onClose}
      returnFocus={returnFocus}
    >
      <PersonaFields
        draft={draft}
        busy={busy}
        onChange={setDraft}
        catalog={{ ...catalog, models }}
      />
      {unavailable && (
        <p className="inline-error" role="alert">
          The saved model is unavailable on this instance. Select an available model before saving.
        </p>
      )}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <PersonaActions
        persona={persona}
        valid={valid}
        pending={pending}
        onSave={() => void savePersona(draft, busy, onSave, setPending, setError)}
        onDelete={
          onDelete ? () => void deletePersona(busy, onDelete, setPending, setError) : undefined
        }
      />
    </PersonaDialog>
  );
}

function PersonaDialog({
  title,
  busy,
  onClose,
  returnFocus,
  children,
}: {
  title: string;
  busy: boolean;
  onClose(): void;
  returnFocus: HTMLElement | null;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
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
              <h2>{title}</h2>
            </Dialog.Title>
            <Dialog.Close asChild>
              <button className="icon-button" aria-label="Close" disabled={busy}>
                <X />
              </button>
            </Dialog.Close>
          </header>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PersonaFields({
  catalog,
  draft,
  busy,
  onChange,
}: {
  catalog: PublicInferenceConfig;
  draft: Persona;
  busy: boolean;
  onChange(value: Persona): void;
}) {
  return (
    <>
      <IconPicker draft={draft} busy={busy} onChange={onChange} />
      <TextFields draft={draft} busy={busy} onChange={onChange} />
      <label htmlFor="persona-model">
        Model
        <ModelSelect
          value={draft.model}
          catalog={catalog}
          disabled={busy}
          onChange={(model) => onChange({ ...draft, model })}
        />
      </label>
      <div className="field-grid">
        <PersonaSelect
          label="Tone"
          value={draft.tone}
          disabled={busy}
          options={['warm', 'neutral', 'direct']}
          onChange={(tone) => onChange({ ...draft, tone: tone as Persona['tone'] })}
        />
        <PersonaSelect
          label="Brevity"
          value={draft.brevity}
          disabled={busy}
          options={['brief', 'balanced', 'detailed']}
          onChange={(brevity) => onChange({ ...draft, brevity: brevity as Persona['brevity'] })}
        />
        <PersonaSelect
          label="Challenge"
          value={draft.challenge}
          disabled={busy}
          options={['gentle', 'balanced', 'direct']}
          onChange={(challenge) =>
            onChange({ ...draft, challenge: challenge as Persona['challenge'] })
          }
        />
      </div>
    </>
  );
}

function IconPicker({
  draft,
  busy,
  onChange,
}: {
  draft: Persona;
  busy: boolean;
  onChange(value: Persona): void;
}) {
  return (
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
            onClick={() => onChange({ ...draft, icon: key as Persona['icon'] })}
          >
            <Icon size={20} aria-hidden />
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function TextFields({
  draft,
  busy,
  onChange,
}: {
  draft: Persona;
  busy: boolean;
  onChange(value: Persona): void;
}) {
  return (
    <>
      <label htmlFor="persona-name">
        Name
        <input
          id="persona-name"
          value={draft.name}
          disabled={busy}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      <label htmlFor="persona-prompt">
        Instructions
        <textarea
          id="persona-prompt"
          rows={6}
          value={draft.prompt}
          disabled={busy}
          onChange={(event) => onChange({ ...draft, prompt: event.target.value })}
        />
      </label>
    </>
  );
}

function chatModel(model: InferenceModel) {
  return (
    model.inputModalities.includes('text') &&
    model.outputModalities.includes('text') &&
    model.supportsTools !== false
  );
}
const DEFAULT_MODEL_CHOICE = '__instance_default__';
function ModelSelect({
  catalog,
  value,
  disabled,
  onChange,
}: {
  catalog: PublicInferenceConfig;
  value?: string;
  disabled: boolean;
  onChange(model: string | undefined): void;
}) {
  return (
    <Select
      value={value ?? DEFAULT_MODEL_CHOICE}
      disabled={disabled || !catalog.models.length}
      onValueChange={(model) => onChange(model === DEFAULT_MODEL_CHOICE ? undefined : model)}
    >
      <SelectTrigger id="persona-model" aria-label="Model">
        <SelectValue />
        <ChevronDown size={14} aria-hidden />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          value={DEFAULT_MODEL_CHOICE}
          disabled={!catalog.models.some(({ id }) => id === catalog.defaultModel)}
        >
          Default (
          {catalog.models.find(({ id }) => id === catalog.defaultModel)?.name ?? 'unavailable'})
        </SelectItem>
        {value && !catalog.models.some(({ id }) => id === value) && (
          <SelectItem value={value} disabled>
            {value} (unavailable)
          </SelectItem>
        )}
        {catalog.models.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.name}
            {model.weight > 1 ? ` (${model.weight} messages)` : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function PersonaSelect({
  label,
  value,
  disabled,
  options,
  onChange,
}: {
  label: string;
  value: string;
  disabled: boolean;
  options: readonly string[];
  onChange(value: string): void;
}) {
  return (
    <label>
      {label}
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue />
          <ChevronDown size={14} aria-hidden />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {option[0]?.toUpperCase()}
              {option.slice(1)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

function PersonaActions({
  persona,
  valid,
  pending,
  onSave,
  onDelete,
}: {
  persona: Persona;
  valid: boolean;
  pending: 'save' | 'delete' | null;
  onSave(): void;
  onDelete?(): void;
}) {
  const busy = pending !== null;
  return (
    <footer>
      {onDelete && persona.id && (
        <button className="danger" onClick={onDelete} disabled={busy}>
          {pending === 'delete' ? 'Deleting…' : 'Delete persona'}
        </button>
      )}
      <span />
      <Dialog.Close asChild>
        <button disabled={busy}>Cancel</button>
      </Dialog.Close>
      <button className="primary" onClick={onSave} disabled={!valid || busy}>
        {pending === 'save' ? 'Saving…' : 'Save persona'}
      </button>
    </footer>
  );
}

async function savePersona(
  draft: Persona,
  busy: boolean,
  onSave: Props['onSave'],
  setPending: (value: 'save' | 'delete' | null) => void,
  setError: (value: string) => void,
) {
  if (busy || !draft.name.trim() || !draft.prompt.trim()) return;
  setError('');
  setPending('save');
  try {
    await onSave(draft);
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : 'The persona could not be saved.');
    setPending(null);
  }
}

async function deletePersona(
  busy: boolean,
  onDelete: NonNullable<Props['onDelete']>,
  setPending: (value: 'save' | 'delete' | null) => void,
  setError: (value: string) => void,
) {
  if (busy) return;
  setError('');
  setPending('delete');
  try {
    await onDelete();
  } catch (cause) {
    setError(cause instanceof Error ? cause.message : 'The persona could not be deleted.');
    setPending(null);
  }
}
