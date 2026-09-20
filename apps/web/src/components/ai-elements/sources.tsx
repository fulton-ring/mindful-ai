import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDownIcon, ExternalLinkIcon, LinkIcon } from 'lucide-react';
import type { ComponentProps } from 'react';

// Adapted from AI Elements Sources.
export function Sources({ className = '', ...props }: ComponentProps<typeof Collapsible.Root>) {
  return (
    <Collapsible.Root
      defaultOpen={false}
      {...props}
      className={`inline-block max-w-full text-sm ${className}`}
    />
  );
}

export function SourcesTrigger({
  count,
  className = '',
  ...props
}: ComponentProps<typeof Collapsible.Trigger> & { count: number }) {
  return (
    <Collapsible.Trigger
      {...props}
      className={`group inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)] ${className}`}
    >
      <LinkIcon size={14} aria-hidden />
      <span>{count === 1 ? '1 source' : `${count} sources`}</span>
      <ChevronDownIcon
        size={13}
        aria-hidden
        className="transition-transform group-data-[state=open]:rotate-180"
      />
    </Collapsible.Trigger>
  );
}

export function SourcesContent({
  className = '',
  ...props
}: ComponentProps<typeof Collapsible.Content>) {
  return (
    <Collapsible.Content
      {...props}
      className={`ml-1 mt-1 flex max-w-prose flex-col gap-1 ${className}`}
    />
  );
}

export function Source({ className = '', children, ...props }: ComponentProps<'a'>) {
  return (
    <a
      {...props}
      target="_blank"
      rel="noreferrer noopener"
      className={`inline-flex min-w-0 items-center gap-1.5 rounded px-1.5 py-1 text-xs text-[var(--muted)] hover:bg-[var(--line)] hover:text-[var(--ink)] ${className}`}
    >
      <span className="truncate">{children}</span>
      <ExternalLinkIcon size={12} className="shrink-0" aria-hidden />
    </a>
  );
}
