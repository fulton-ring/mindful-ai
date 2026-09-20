import * as Collapsible from '@radix-ui/react-collapsible';
import { useControllableState } from '@radix-ui/react-use-controllable-state';
import { BrainIcon, ChevronDownIcon } from 'lucide-react';
import {
  type ComponentProps,
  createContext,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { Streamdown } from 'streamdown';

type ContextValue = {
  isStreaming: boolean;
  isOpen: boolean;
  setIsOpen: (open: boolean) => void;
  duration?: number;
};
const ReasoningContext = createContext<ContextValue | null>(null);
export function useReasoning() {
  const value = useContext(ReasoningContext);
  if (!value) throw new Error('Reasoning components must be used within Reasoning');
  return value;
}
export type ReasoningProps = ComponentProps<typeof Collapsible.Root> & {
  isStreaming?: boolean;
  defaultOpen?: boolean;
  duration?: number;
};
// Adapted from https://github.com/vercel/ai-elements/blob/main/packages/elements/src/reasoning.tsx
export const Reasoning = memo(
  ({
    isStreaming = false,
    defaultOpen,
    open,
    onOpenChange,
    duration,
    children,
    ...props
  }: ReasoningProps) => {
    const [isOpen, setIsOpen] = useControllableState({
      prop: open,
      defaultProp: defaultOpen ?? isStreaming,
      onChange: onOpenChange,
    });
    const start = useRef<number | null>(null);
    const [measured, setMeasured] = useState(duration);
    useEffect(() => {
      if (isStreaming) {
        if (defaultOpen !== false) setIsOpen(true);
        if (start.current === null) start.current = Date.now();
      } else if (start.current !== null) {
        setMeasured(Math.ceil((Date.now() - start.current) / 1000));
        start.current = null;
        const timer = window.setTimeout(() => setIsOpen(false), 1000);
        return () => window.clearTimeout(timer);
      }
    }, [isStreaming, defaultOpen, setIsOpen]);
    return (
      <ReasoningContext.Provider value={{ isStreaming, isOpen, setIsOpen, duration: measured }}>
        <Collapsible.Root
          {...props}
          open={isOpen}
          onOpenChange={setIsOpen}
          className={`reasoning ${props.className ?? ''}`}
        >
          {children}
        </Collapsible.Root>
      </ReasoningContext.Provider>
    );
  },
);
export const ReasoningTrigger = memo(
  ({
    children,
    getThinkingMessage,
    ...props
  }: ComponentProps<typeof Collapsible.Trigger> & {
    getThinkingMessage?: (streaming: boolean, duration?: number) => ReactNode;
  }) => {
    const { isStreaming, isOpen, duration } = useReasoning();
    const message = isStreaming
      ? 'Thinking…'
      : duration === undefined
        ? 'Thought for a few seconds'
        : `Thought for ${duration} seconds`;
    return (
      <Collapsible.Trigger {...props} className={`reasoning-trigger ${props.className ?? ''}`}>
        {children ?? (
          <>
            <BrainIcon size={15} aria-hidden />
            <span>{getThinkingMessage?.(isStreaming, duration) ?? message}</span>
            <ChevronDownIcon size={15} className={isOpen ? 'is-open' : ''} aria-hidden />
          </>
        )}
      </Collapsible.Trigger>
    );
  },
);
export const ReasoningContent = memo(
  ({
    children,
    ...props
  }: Omit<ComponentProps<typeof Collapsible.Content>, 'children'> & { children: string }) => (
    <Collapsible.Content {...props} className={`reasoning-content ${props.className ?? ''}`}>
      <Streamdown skipHtml>{children}</Streamdown>
    </Collapsible.Content>
  ),
);
