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
} from '@walden/contracts';
import type { AgentCheckpoints } from '../agent/checkpoints';
import type { LoadedAttachment } from '../chat/attachments/attachments';
import type { Bindings } from '../types';

export type ServiceEnv = Partial<Bindings>;

export type AgentTurnInput = {
  ownerId?: string;
  telemetryUserId?: string;
  turnId: string;
  requestId: string;
  conversation: Conversation;
  note: Note | null;
  persona: Persona;
  message: string;
  attachments?: LoadedAttachment[];
  action?: ChatRequest['action'];
  noteProposalRequested?: boolean;
  pendingIntervention?: Intervention;
  /** Still-pending note suggestions for this note, which a new proposal may supersede. */
  pendingProposals?: EditProposal[];
};
export type AgentService = {
  streamTurn(
    input: AgentTurnInput,
    checkpoints: AgentCheckpoints,
    signal?: AbortSignal,
  ): Promise<AsyncIterable<ChatEvent>>;
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
