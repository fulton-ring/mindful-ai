import {
  Group,
  type GroupProps,
  Panel,
  type PanelProps,
  Separator,
  type SeparatorProps,
} from 'react-resizable-panels';

export function ResizablePanelGroup({ className = '', ...props }: GroupProps) {
  return <Group className={`resizable-panel-group ${className}`} {...props} />;
}

export function ResizablePanel({ className = '', ...props }: PanelProps) {
  return <Panel className={`resizable-panel ${className}`} {...props} />;
}

export function ResizableHandle({ className = '', ...props }: SeparatorProps) {
  return <Separator className={`resizable-handle ${className}`} {...props} />;
}
