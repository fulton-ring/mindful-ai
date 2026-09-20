import * as Collapsible from '@radix-ui/react-collapsible';
import { CheckCircle2Icon, ChevronDownIcon, CircleDashedIcon, XCircleIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';

export type ToolState = 'running' | 'complete' | 'error';

const status = {
  running: { label: 'Running', Icon: CircleDashedIcon },
  complete: { label: 'Completed', Icon: CheckCircle2Icon },
  error: { label: 'Failed', Icon: XCircleIcon },
} satisfies Record<ToolState, { label: string; Icon: typeof CircleDashedIcon }>;

export function toolLabel(name: string) {
  if (name === 'readWebPage') return 'Read page';
  if (name === 'searchSources') return 'Search sources';
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : 'Tool';
}

// Adapted from AI Elements Tool. This app intentionally omits input and raw-output renderers.
export function Tool({ className = '', ...props }: ComponentProps<typeof Collapsible.Root>) {
  return (
    <Collapsible.Root
      defaultOpen={false}
      {...props}
      className={`inline-block max-w-full text-sm ${className}`}
    />
  );
}

export function ToolHeader({
  name,
  state,
  children,
  className = '',
  ...props
}: Omit<ComponentProps<typeof Collapsible.Trigger>, 'children'> & {
  name: string;
  state: ToolState;
  children?: ReactNode;
}) {
  const { Icon, label } = status[state];
  return (
    <Collapsible.Trigger
      {...props}
      className={`group inline-flex max-w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)] ${className}`}
    >
      <Icon size={14} aria-hidden className={state === 'running' ? 'animate-spin' : ''} />
      <span className="truncate">{children ?? name}</span>
      <span className="sr-only">{label}</span>
      <ChevronDownIcon
        size={13}
        aria-hidden
        className="shrink-0 transition-transform group-data-[state=open]:rotate-180"
      />
    </Collapsible.Trigger>
  );
}

export function ToolContent({
  className = '',
  ...props
}: ComponentProps<typeof Collapsible.Content>) {
  return (
    <Collapsible.Content
      {...props}
      className={`ml-5 mt-0.5 max-w-prose text-xs text-[var(--muted)] ${className}`}
    />
  );
}
