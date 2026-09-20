import type {
  Annotation,
  AnnotationEvent,
  ChatEvent,
  ChatRequest,
  Conversation,
  EditProposal,
  Intervention,
  Message,
  Note,
  NoteProposalEvent,
  Persona,
  Usage,
} from '@walden/contracts';

export type ServiceEnv = {
  DB?: D1Database;
  AI?: Ai;
  BROWSER?: BrowserRun;
  AI_SEARCH?: AiSearchNamespace;
  AI_SEARCH_INSTANCE?: string;
  AI_MODEL?: string;
  AI_PROVIDER?: string;
  OPENROUTER_API_KEY?: string;
  R2_ACCOUNT_ID?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_API_TOKEN?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_ID?: string;
  APP_URL?: string;
  MCP_SERVER_URL?: string;
  MCP_SERVER_TOKEN?: string;
  MCP_ALLOWED_TOOLS?: string;
  MCP_TOOL_EFFECTS?: string;
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
};

export type AgentTurnInput = {
  ownerId?: string;
  telemetryUserId?: string;
  turnId: string;
  requestId: string;
  conversation: Conversation;
  note: Note | null;
  persona: Persona;
  message: string;
  action?: ChatRequest['action'];
  noteProposalRequested?: boolean;
  pendingIntervention?: Intervention;
  /** Still-pending note suggestions for this note, which a new proposal may supersede. */
  pendingProposals?: EditProposal[];
};
export type AgentService = {
  streamTurn(input: AgentTurnInput, signal?: AbortSignal): Promise<AsyncIterable<ChatEvent>>;
  annotateTurn(
    input: AgentTurnInput,
    assistantMessage: Message,
    signal?: AbortSignal,
  ): Promise<Annotation[]>;
  streamAnnotations(
    input: AgentTurnInput,
    assistantMessage: Message,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<AnnotationEvent>>;
  streamNoteProposal(
    input: AgentTurnInput,
    assistantMessage: Message,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<NoteProposalEvent>>;
};
export type StoredUsage = Pick<
  Usage,
  'plan' | 'used' | 'limit' | 'resetsAt' | 'inputTokens' | 'outputTokens'
>;
