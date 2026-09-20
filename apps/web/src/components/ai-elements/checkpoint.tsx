import { BookmarkIcon } from 'lucide-react';
import type { ComponentProps, HTMLAttributes } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

export type CheckpointProps = HTMLAttributes<HTMLDivElement>;
export function Checkpoint({ className = '', children, ...props }: CheckpointProps) {
  return (
    <div
      {...props}
      className={`flex items-center gap-0.5 overflow-hidden text-[var(--muted)] ${className}`}
    >
      {children}
      <span className="h-px flex-1 bg-[var(--line)]" aria-hidden />
    </div>
  );
}

export type CheckpointIconProps = ComponentProps<typeof BookmarkIcon>;
export function CheckpointIcon({ className = '', children, ...props }: CheckpointIconProps) {
  return children ?? <BookmarkIcon {...props} className={`size-4 shrink-0 ${className}`} />;
}

export type CheckpointTriggerProps = ComponentProps<'button'> & { tooltip?: string };
export function CheckpointTrigger({
  children,
  className = '',
  tooltip,
  ...props
}: CheckpointTriggerProps) {
  const button = (
    <button
      type="button"
      {...props}
      className={`rounded-md px-2 py-1 text-xs hover:bg-[var(--line)] ${className}`}
    >
      {children}
    </button>
  );
  return tooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" align="start">
        {tooltip}
      </TooltipContent>
    </Tooltip>
  ) : (
    button
  );
}
