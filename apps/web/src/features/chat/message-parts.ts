import type { LearningCheck, LearningCheckResponse, WaldenUIMessage } from '@walden/contracts';
import { getToolName, isToolUIPart } from 'ai';

export { uiMessageText as messageText } from '@walden/contracts';

type Part = WaldenUIMessage['parts'][number];
type ToolPart = Extract<Part, { toolCallId: string }>;
export type FilePart = Extract<Part, { type: 'file' }>;
export type ActivitySource = { id: string; url: string; title?: string };
export type ActivityTool = {
  id: string;
  name: string;
  state: 'running' | 'complete' | 'error';
  summary: string;
  /** The public research query or page, never raw tool arguments. */
  query?: string;
  sources?: ActivitySource[];
};

export const isInterrupted = (message: WaldenUIMessage) =>
  message.metadata?.status === 'interrupted';

export function reasoningText(message: WaldenUIMessage) {
  return message.parts
    .flatMap((part) => (part.type === 'reasoning' && part.text ? [part.text] : []))
    .join('\n\n');
}

export function learningCheckOf(message: WaldenUIMessage): LearningCheck | undefined {
  for (const part of message.parts)
    if (part.type === 'data-intervention' && part.data.kind === 'learning_check') return part.data;
  return undefined;
}

export function learningCheckResponseOf(
  message: WaldenUIMessage,
): LearningCheckResponse | undefined {
  return message.parts.find((part) => part.type === 'data-learning-check-response')?.data;
}

export function filePartsOf(message: WaldenUIMessage): FilePart[] {
  return message.parts.filter((part): part is FilePart => part.type === 'file');
}

export function sourcesOf(parts: Part[]): ActivitySource[] {
  return parts.flatMap((part) =>
    part.type === 'source-url'
      ? [{ id: part.sourceId, url: part.url, ...(part.title ? { title: part.title } : {}) }]
      : [],
  );
}

const RUNNING: Record<string, string> = {
  searchWeb: 'Searching the web…',
  readWebPage: 'Reading source…',
  searchSources: 'Searching sources…',
  listWebLinks: 'Listing page links…',
  screenshotWebPage: 'Capturing page…',
};

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : undefined;
}

/** A finished tool's public output is `{ sources?: {url, title?}[], summary? }`. */
function toolSources(part: ToolPart): ActivitySource[] | undefined {
  const sources = part.state === 'output-available' ? field(part.output, 'sources') : undefined;
  if (!Array.isArray(sources)) return undefined;
  return sources.flatMap((source, index) => {
    const url = text(field(source, 'url'));
    const title = text(field(source, 'title'));
    return url ? [{ id: `${part.toolCallId}:${index}`, url, ...(title ? { title } : {}) }] : [];
  });
}

function toolState(part: ToolPart, interrupted: boolean): ActivityTool['state'] {
  if (part.state === 'output-error' || part.state === 'output-denied') return 'error';
  if (part.state === 'output-available') return 'complete';
  return interrupted ? 'error' : 'running';
}

function toolSummary(name: string, part: ToolPart, state: ActivityTool['state']) {
  if (state === 'running') return RUNNING[name] ?? 'Using tool…';
  if (state === 'complete') return text(field(part.output, 'summary')) ?? '';
  if (part.state === 'output-error') return part.errorText || 'Tool failed';
  return 'Stopped';
}

/** The response's research steps, as friendly labels derived from each tool call. */
export function activityTools(parts: Part[], interrupted = false): ActivityTool[] {
  return parts.filter(isToolUIPart).map((part) => {
    const tool = part as ToolPart;
    const name = getToolName(part);
    const state = toolState(tool, interrupted);
    const query = text(field(part.input, 'query')) ?? text(field(part.input, 'url'));
    const sources = toolSources(tool);
    return {
      id: part.toolCallId,
      name,
      state,
      summary: toolSummary(name, tool, state),
      ...(query ? { query } : {}),
      ...(sources ? { sources } : {}),
    };
  });
}
