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
export type NoteDecision = z.infer<typeof noteDecisionSchema>;
export const noteHistoryActionSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  operationId: z.string().min(1),
});
export const personaIconSchema = z.enum([
  'compass',
  'swords',
  'graduation-cap',
  'lightbulb',
  'book',
  'flask',
  'pencil',
  'user',
]);
/** `weight` is what one message on the model costs against the sliding message budget (1–3). */
export const PERSONA_MODELS = [
  { id: '@cf/zai-org/glm-5.3-flash', label: 'GLM 5.3 Flash', weight: 1 },
  { id: '@cf/google/gemma-4-26b-a4b-it', label: 'Gemma 4', weight: 1 },
  { id: '@cf/qwen/qwen3.8-27b', label: 'Qwen 3.8', weight: 2 },
] as const;
export type PersonaModel = (typeof PERSONA_MODELS)[number]['id'];
/** Models outside the persona list (such as a development provider override) cost 1. */
export const modelWeight = (modelId: string): number =>
  PERSONA_MODELS.find(({ id }) => id === modelId)?.weight ?? 1;
const personaModelIds = PERSONA_MODELS.map((model) => model.id) as [
  PersonaModel,
  ...PersonaModel[],
];
export const personaSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  prompt: z.string().max(4000),
  model: z.enum(personaModelIds).optional(),
  icon: personaIconSchema.optional(),
  brevity: z.enum(['brief', 'balanced', 'detailed']),
  challenge: z.enum(['gentle', 'balanced', 'direct']),
  tone: z.enum(['warm', 'neutral', 'direct']),
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
export type LearningCheckQuestion =
  | {
      id: string;
      header: string;
      format: 'multiple_choice';
      question: string;
      options: string[];
    }
  | { id: string; header: string; format: 'short_answer'; question: string };
export type LearningCheck = {
  id: string;
  kind: 'learning_check';
  questions: LearningCheckQuestion[];
};
export type LearningCheckResponse = {
  checkId: string;
  answers: Record<string, { answers: string[] }>;
};
export type Intervention =
  | { id: string; kind: 'ghost'; proposal: EditProposal }
  | { id: string; kind: 'ask'; question: string; options: string[] }
  | { id: string; kind: 'record'; text: string; reason: string }
  | LearningCheck;
export type ToolActivity = {
  id: string;
  name: string;
  state: 'running' | 'complete' | 'error';
  summary: string;
  /** Public research query, never raw tool arguments. */
  query?: string;
  sources?: MessageSource[];
};
export type MessageSource = { id: string; url: string; title?: string };
export type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: Array<{ id: string; name: string; mimeType: string; size: number }>;
  /** Persona that produced an assistant reply, as named when it was written. */
  personaName?: string;
  reasoning?: string;
  createdAt: string;
  annotations?: Annotation[];
  highlights?: MessageHighlight[];
  tools?: ToolActivity[];
  sources?: MessageSource[];
  /** A structured assistant request rendered as an interactive quiz card. */
  learningCheck?: LearningCheck;
  /** Structured answers rendered separately from ordinary user prose. */
  learningCheckResponse?: LearningCheckResponse;
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
  /** Defaults to on for existing conversations. */
  webSearchEnabled?: boolean;
  branchId: string;
  branches: ConversationBranch[];
};
export type ConversationSummary = {
  noteUpdatedAt?: string | null;
  lastMessageAt?: string | null;
  id: string;
  noteId: string | null;
  title: string;
  updatedAt: string;
  expiresAt: string;
};
export type ChatEvent =
  | { type: 'reset' }
  | { type: 'text-snapshot'; text: string; reasoning: string }
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
      userMessageId?: string;
      message: Message;
      conversationId: string;
      branchId: string;
      title: string;
      expiresAt: string;
      annotationsHandled?: boolean;
    }
  | { type: 'usage'; usage: { inputTokens: number; outputTokens: number } }
  | {
      type: 'error';
      message: string;
      code?: ChatFailureCode;
      partialMessage?: Message;
      userMessageId?: string;
      branchId?: string;
    };
export type ChatFailureCode =
  | 'cancelled'
  | 'timeout'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'provider_unavailable'
  | 'provider_error'
  | 'output_limit'
  | 'internal_error';
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
  dismissSuggestionIds: z.array(z.string().min(1).max(200)).max(20).optional(),
});
export const chatRequestSchema = z
  .object({
    requestId: z.string().min(1),
    conversationId: z.string(),
    branchId: z.string().min(1),
    noteRevision: z.number().int().nonnegative().nullable(),
    message: z.string().max(16000),
    attachmentIds: z.array(z.string().uuid()).max(5).optional(),
    learningCheckResponse: z
      .object({
        checkId: z.string().min(1).max(200),
        answers: z.record(
          z.string().min(1).max(100),
          z.object({ answers: z.array(z.string().min(1).max(1000)).min(1).max(2) }),
        ),
      })
      .optional(),
    personaId: z.string(),
    regenerateMessageId: z.string().min(1).optional(),
    editMessageId: z.string().min(1).optional(),
    action: z
      .enum(['message', 'challenge', 'source', 'capture', 'feedback', 'stop_checks'])
      .default('message'),
  })
  .refine(
    (request) => request.message.trim().length > 0 || Boolean(request.attachmentIds?.length),
    {
      message: 'Enter a message or attach a file.',
      path: ['message'],
    },
  )
  .refine(
    (request) =>
      request.message.length <= 2000 ||
      Boolean(request.regenerateMessageId || request.editMessageId),
    {
      message: 'Messages are limited to 2,000 characters.',
      path: ['message'],
    },
  );
export type ChatRequest = z.infer<typeof chatRequestSchema>;
/** Body of the per-message follow-up routes (annotations and note proposals). */
export const messageFollowupRequestSchema = z
  .object({
    conversationId: z.string().min(1),
    branchId: z.string().min(1),
    personaId: z.string(),
    noteRevision: z.number().int().nonnegative().nullable(),
    noteProposalRequested: z.boolean().optional(),
    action: z.literal('capture').optional(),
    captureText: z.string().min(1).max(20_000).optional(),
  })
  .superRefine((value, context) => {
    if ((value.action === 'capture') !== (typeof value.captureText === 'string'))
      context.addIssue({
        code: 'custom',
        message: 'Capture action and text must be supplied together',
      });
  });
export type MessageFollowupRequest = z.infer<typeof messageFollowupRequestSchema>;
export type AppConfig = {
  authConfigured: boolean;
  modelConfigured: boolean;
  clerkPublishableKey?: string;
  telemetry?: { key: string; host: string };
};
/** The anchored message budget: the first message opens a window that resets in full. */
export type MessageBudget = {
  used: number;
  limit: number;
  windowHours: number;
  /** When the current window ends, or null when no window is open. */
  resetsAt: string | null;
};
export type Usage = {
  budget: MessageBudget;
  /** Messages you have sent, across every thread that still exists. */
  messagesSent: number;
  /** The persona used in the most threads, or null when nothing stands out. */
  favoritePersona: string | null;
};
export const DEFAULT_PERSONAS: Persona[] = [
  {
    id: 'thinking-partner',
    name: 'Mentor',
    icon: 'compass',
    prompt:
      'Help me think clearly. Be concise, specific, and willing to disagree. Let my own articulation lead.',
    brevity: 'brief',
    challenge: 'balanced',
    tone: 'neutral',
  },
  {
    id: 'critical-reader',
    name: 'Challenger',
    icon: 'swords',
    prompt:
      'Stress-test my reasoning. Identify weak assumptions, missing evidence, and strong counterarguments. Offer alternative explanations and say what evidence would change the conclusion. Be direct and adversarial toward ideas, not hostile toward me. Acknowledge sound arguments; do not disagree just to be contrarian.',
    brevity: 'balanced',
    challenge: 'direct',
    tone: 'direct',
  },
  {
    id: 'study-partner',
    name: 'Study partner',
    icon: 'graduation-cap',
    prompt:
      'Be my study partner using active recall. Regularly quiz me when appropriate. Do not reveal the answer before I respond. Offer hints, explain what I got right or missed, adapt the difficulty, and revisit mistakes. Respect requests for a direct answer or to stop quizzing. When checks are off, teach without quizzing.',
    brevity: 'balanced',
    challenge: 'balanced',
    tone: 'neutral',
  },
];
