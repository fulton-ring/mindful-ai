import * as Collapsible from '@radix-ui/react-collapsible';
import { useControllableState } from '@radix-ui/react-use-controllable-state';
import { BrainIcon, ChevronDownIcon, DotIcon } from 'lucide-react';
import type { ComponentProps, ReactNode } from 'react';
import { createContext, memo, useContext, useMemo } from 'react';

type ContextValue = { isOpen: boolean; setIsOpen(open: boolean): void };
const ChainOfThoughtContext = createContext<ContextValue | null>(null);

function useChainOfThought() {
  const context = useContext(ChainOfThoughtContext);
  if (!context) throw new Error('ChainOfThought components must be used within ChainOfThought');
  return context;
}

export type ChainOfThoughtProps = ComponentProps<'div'> & {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?(open: boolean): void;
};

export const ChainOfThought = memo(function ChainOfThought({
  className = '',
  open,
  defaultOpen = false,
  onOpenChange,
  children,
  ...props
}: ChainOfThoughtProps) {
  const [isOpen, setIsOpen] = useControllableState({
    prop: open,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
  });
  const value = useMemo(() => ({ isOpen, setIsOpen }), [isOpen, setIsOpen]);
  return (
    <ChainOfThoughtContext.Provider value={value}>
      <div {...props} className={`not-prose w-full space-y-4 ${className}`}>
        {children}
      </div>
    </ChainOfThoughtContext.Provider>
  );
});

export const ChainOfThoughtHeader = memo(function ChainOfThoughtHeader({
  className = '',
  children,
  ...props
}: ComponentProps<typeof Collapsible.Trigger>) {
  const { isOpen, setIsOpen } = useChainOfThought();
  return (
    <Collapsible.Root open={isOpen} onOpenChange={setIsOpen}>
      <Collapsible.Trigger
        {...props}
        className={`flex w-full items-center gap-2 text-sm text-[var(--muted)] transition-colors hover:text-[var(--ink)] ${className}`}
      >
        <BrainIcon className="size-4" aria-hidden />
        <span className="flex-1 text-left">{children ?? 'Chain of Thought'}</span>
        <ChevronDownIcon
          className={`size-4 transition-transform ${isOpen ? 'rotate-180' : 'rotate-0'}`}
          aria-hidden
        />
      </Collapsible.Trigger>
    </Collapsible.Root>
  );
});

export type ChainOfThoughtStepProps = ComponentProps<'div'> & {
  icon?: typeof DotIcon;
  label: ReactNode;
  description?: ReactNode;
  status?: 'complete' | 'active' | 'pending';
};
const statusClasses = {
  active: 'text-[var(--ink)]',
  complete: 'text-[var(--muted)]',
  pending: 'text-[color-mix(in_srgb,var(--muted)_50%,transparent)]',
};
export const ChainOfThoughtStep = memo(function ChainOfThoughtStep({
  className = '',
  icon: Icon = DotIcon,
  label,
  description,
  status = 'complete',
  children,
  ...props
}: ChainOfThoughtStepProps) {
  return (
    <div {...props} className={`flex gap-2 text-sm ${statusClasses[status]} ${className}`}>
      <div className="relative mt-0.5">
        <Icon className="size-4" aria-hidden />
        <div className="absolute bottom-0 left-1/2 top-7 -mx-px w-px bg-[var(--line)]" />
      </div>
      <div className="flex-1 space-y-2 overflow-hidden">
        <div>{label}</div>
        {description && <div className="text-xs text-[var(--muted)]">{description}</div>}
        {children}
      </div>
    </div>
  );
});

export const ChainOfThoughtSearchResults = memo(function ChainOfThoughtSearchResults({
  className = '',
  ...props
}: ComponentProps<'div'>) {
  return <div {...props} className={`flex flex-wrap items-center gap-2 ${className}`} />;
});
export const ChainOfThoughtSearchResult = memo(function ChainOfThoughtSearchResult({
  className = '',
  ...props
}: ComponentProps<'span'>) {
  return (
    <span
      {...props}
      className={`inline-flex max-w-full rounded-full bg-[var(--line)] px-2 py-0.5 text-xs font-normal ${className}`}
    />
  );
});

export const ChainOfThoughtContent = memo(function ChainOfThoughtContent({
  className = '',
  children,
  ...props
}: ComponentProps<typeof Collapsible.Content>) {
  const { isOpen } = useChainOfThought();
  return (
    <Collapsible.Root open={isOpen}>
      <Collapsible.Content
        {...props}
        className={`mt-2 space-y-3 text-[var(--ink)] outline-none ${className}`}
      >
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
});

export const ChainOfThoughtImage = memo(function ChainOfThoughtImage({
  className = '',
  children,
  caption,
  ...props
}: ComponentProps<'div'> & { caption?: string }) {
  return (
    <div {...props} className={`mt-2 space-y-2 ${className}`}>
      <div className="relative flex max-h-[22rem] items-center justify-center overflow-hidden rounded-lg bg-[var(--line)] p-3">
        {children}
      </div>
      {caption && <p className="text-xs text-[var(--muted)]">{caption}</p>}
    </div>
  );
});
