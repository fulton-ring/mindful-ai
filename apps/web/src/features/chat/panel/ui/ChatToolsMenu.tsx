import { Paperclip, SlidersHorizontal } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '../../../../components/ui/popover';

type Props = {
  webSearch: boolean;
  learningChecks: boolean;
  autoHighlights: boolean;
  disabled: boolean;
  onPreference(setting: 'learningChecks' | 'webSearch', enabled: boolean): void;
  onAutoHighlights(enabled: boolean): void;
};

/** Per-thread controls that live behind the composer sliders button. */
export function ChatToolsMenu({
  webSearch,
  learningChecks,
  autoHighlights,
  disabled,
  onPreference,
  onAutoHighlights,
}: Props) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="icon-button" aria-label="Chat tools">
          <SlidersHorizontal size={16} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 rounded-md border border-border bg-card p-1 text-foreground shadow-md"
        side="top"
        align="start"
      >
        <button
          type="button"
          disabled
          title="Coming soon"
          className="flex w-full items-center justify-between gap-3 rounded-sm px-2 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add files
          <Paperclip size={16} aria-hidden />
        </button>
        <Preference
          label="Web search"
          value={webSearch}
          disabled={disabled}
          onChange={(value) => onPreference('webSearch', value)}
        />
        <Preference
          label="Learning checks"
          value={learningChecks}
          disabled={disabled}
          onChange={(value) => onPreference('learningChecks', value)}
        />
        <Preference label="Auto highlights" value={autoHighlights} onChange={onAutoHighlights} />
      </PopoverContent>
    </Popover>
  );
}

function Preference({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-2 text-sm hover:bg-accent">
      <span>{label}</span>
      <input
        type="checkbox"
        className="accent-[var(--accent)]"
        aria-label={label}
        checked={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
