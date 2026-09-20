import { z } from 'zod';

export const provenanceSpanSchema = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  origin: z.enum(['user', 'agent']),
  verbatim: z.boolean(),
  captureId: z.string().optional(),
});
export type ProvenanceSpan = z.infer<typeof provenanceSpanSchema>;
export const noteSchema = z.object({
  id: z.string(),
  title: z.string(),
  markdown: z.string(),
  revision: z.number().int().nonnegative(),
  provenance: z.array(provenanceSpanSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Note = z.infer<typeof noteSchema>;
export const editProposalSchema = z.object({
  id: z.string(),
  noteId: z.string(),
  baseRevision: z.number().int(),
  /**
   * Empty for an addition, which carries no position at all: `newText` is the
   * text to add, and where it goes is computed from the note each time it is
   * previewed or applied. Non-empty for a replacement, which must match exactly
   * and fail loudly when the text it was written against is gone.
   */
  oldText: z.string(),
  newText: z.string(),
  reason: z.string(),
  /**
   * Id of a still-pending suggestion this one supersedes. Lets a turn revise its
   * own earlier proposal instead of stacking a second one the reader has to
   * reconcile by hand. The replaced row is invalidated as this one is stored.
   */
  replaces: z.string().nullable().optional(),
  status: z.enum(['pending', 'accepted', 'dismissed', 'invalidated']).default('pending'),
});
export type EditProposal = z.infer<typeof editProposalSchema>;
export const noteSuggestionSchema = editProposalSchema.extend({
  conversationId: z.string().nullable(),
  sourceMessageId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type NoteSuggestion = z.infer<typeof noteSuggestionSchema>;
export const noteStateSchema = z.object({
  note: noteSchema,
  suggestions: z.array(noteSuggestionSchema),
  canUndo: z.boolean(),
  canRedo: z.boolean(),
});
export type NoteState = z.infer<typeof noteStateSchema>;
export const noteDecisionSchema = z.object({
  decision: z.enum(['accept', 'reject']),
  baseRevision: z.number().int().nonnegative(),
  operationId: z.string().min(1),
  /**
   * The note exactly as the reader saw it when they accepted — the rendered
   * document with the other pending suggestions taken back out. Accepting is a
   * save, not a fresh placement: re-deriving the position here is what let an
   * accepted line move somewhere other than where it was drawn. The server
   * still checks that the only difference is this suggestion's own text.
   */
  markdown: z.string().max(200_000).optional(),
});
export const noteHistoryActionSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  operationId: z.string().min(1),
});
export const personaSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  prompt: z.string().max(4000),
  brevity: z.enum(['brief', 'balanced', 'detailed']),
  challenge: z.enum(['gentle', 'balanced', 'direct']),
  tone: z.enum(['warm', 'neutral', 'direct']),
  revision: z.number().int().nonnegative(),
});
export type Persona = z.infer<typeof personaSchema>;
export const ACTIVE_ANNOTATION_KINDS = [
  'fact',
  'claim',
  'assumption',
  'question',
  'decision',
  'explanation',
] as const;
export function isActiveAnnotationKind(kind: string): boolean {
  return ACTIVE_ANNOTATION_KINDS.some((active) => active === kind);
}
export const annotationSchema = z.object({
  id: z.string(),
  quote: z.string(),
  // Retired kinds remain readable in stored transcripts, but are no longer generated or shown.
  kind: z.enum([
    'fact',
    'claim',
    'assumption',
    'question',
    'decision',
    'explanation',
    'reasoning',
    'number',
    'source',
  ]),
  whose: z.enum(['assistant', 'user']),
});
export type Annotation = z.infer<typeof annotationSchema>;
export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const;
export const HIGHLIGHT_ORIGINS = ['user', 'agent'] as const;
export const messageHighlightSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  quote: z.string().min(1),
  // A null color is a durable removal, including suppression of overlapping agent marks.
  color: z.enum(HIGHLIGHT_COLORS).nullable(),
  /** Agent rows are regenerable model output; user rows are never replaced. */
  origin: z.enum(HIGHLIGHT_ORIGINS).default('user'),
  /** Semantic class, agent rows only. Drives the wash colour. */
  kind: z.string().optional(),
});
export type MessageHighlight = z.infer<typeof messageHighlightSchema>;
export type Intervention =
  | { id: string; kind: 'ghost'; proposal: EditProposal }
  | { id: string; kind: 'ask'; question: string; options: string[] }
  | { id: string; kind: 'record'; text: string; reason: string }
  | { id: string; kind: 'learning_check'; question: string; options?: string[] };
export type ToolActivity = {
  id: string;
  name: string;
  state: 'running' | 'complete' | 'error';
  summary: string;
};
export type MessageSource = { id: string; url: string; title?: string };
export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Persona that produced an assistant reply, as named when it was written. */
  personaName?: string;
  reasoning?: string;
  createdAt: string;
  annotations?: Annotation[];
  highlights?: MessageHighlight[];
  tools?: ToolActivity[];
  sources?: MessageSource[];
  contextCompacted?: boolean;
  incomplete?: boolean;
};
export type ConversationBranch = {
  id: string;
  forkedFromMessageId: string | null;
  headMessageId: string | null;
  expiresAt: string;
};
export type Conversation = {
  id: string;
  title: string;
  noteId: string | null;
  messages: Message[];
  expiresAt: string;
  /** False only when the user has turned learning checks off for this thread. */
  learningChecksEnabled: boolean;
  branchId: string;
  branches: ConversationBranch[];
};
export type ConversationSummary = {
  id: string;
  noteId: string | null;
  title: string;
  updatedAt: string;
  expiresAt: string;
};
export type ChatEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'status'; text: string }
  | { type: 'tool'; tool: ToolActivity }
  | { type: 'source'; source: MessageSource }
  | { type: 'context-compacted' }
  | { type: 'annotation'; annotation: Annotation }
  | { type: 'intervention'; intervention: Intervention }
  | {
      type: 'done';
      message: Message;
      conversationId: string;
      branchId: string;
      title: string;
      expiresAt: string;
      annotationsHandled?: boolean;
    }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | { type: 'error'; message: string; partialMessage?: Message };
export type NoteProposalEvent =
  | { type: 'preview'; proposal: EditProposal; operationIndex?: number }
  | { type: 'done'; proposal: EditProposal | null; proposals?: EditProposal[]; reason?: string }
  | { type: 'error'; message: string };
export type AnnotationEvent =
  | { type: 'annotation'; annotation: Annotation }
  | { type: 'done'; annotations: Annotation[] }
  | { type: 'error'; message: string };
export const saveNoteSchema = z.object({
  operationId: z.string().min(1),
  baseRevision: z.number().int().nonnegative(),
  markdown: z.string().max(200000),
  provenance: z.array(provenanceSpanSchema).max(10000),
  dismissSuggestionId: z.string().min(1).max(200).optional(),
  dismissSuggestionIds: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export const chatRequestSchema = z.object({
  requestId: z.string().min(1),
  conversationId: z.string(),
  branchId: z.string().min(1),
  noteRevision: z.number().int().nonnegative().nullable(),
  message: z.string().min(1).max(16000),
  personaId: z.string(),
  regenerateMessageId: z.string().min(1).optional(),
  editMessageId: z.string().min(1).optional(),
  action: z
    .enum(['message', 'challenge', 'source', 'capture', 'feedback', 'stop_checks'])
    .default('message'),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type AppConfig = {
  authConfigured: boolean;
  billingEnabled?: boolean;
  billingConfigured: boolean;
  modelConfigured: boolean;
  clerkPublishableKey?: string;
  telemetry?: { key: string; host: string };
};
/**
 * Product analytics events. The server validates `kind` against this list, and
 * the client builds its payloads from the same type, so the two cannot drift —
 * they silently had, and every event was rejected for months.
 */
export const PRODUCT_EVENT_KINDS = [
  'session_started',
  'session_ended',
  'note_selected',
  'own_words_saved',
  'note_undo',
  'conversation_opened',
] as const;
export type ProductEventKind = (typeof PRODUCT_EVENT_KINDS)[number];
export type ProductEvent = {
  kind: ProductEventKind;
  sessionId: string;
  id?: string;
  occurredAt?: string;
  metadata?: Record<string, boolean | number | string>;
};

export type Usage = {
  plan: 'free' | 'personal';
  used: number;
  limit: number;
  resetsAt: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Messages you have sent, across every thread that still exists. */
  messagesSent: number;
  /** The persona used in the most threads, or null when nothing stands out. */
  favoritePersona: string | null;
};
export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: 'thinking-partner',
    name: 'Mentor',
    prompt:
      'Help me think clearly. Be concise, specific, and willing to disagree. Let my own articulation lead.',
    brevity: 'brief',
    challenge: 'balanced',
    tone: 'neutral',
    revision: 0,
  },
  {
    id: 'critical-reader',
    name: 'Critical reader',
    prompt:
      'Look for weak assumptions, missing evidence, and alternatives. Be direct without being condescending.',
    brevity: 'balanced',
    challenge: 'direct',
    tone: 'direct',
    revision: 0,
  },
];
