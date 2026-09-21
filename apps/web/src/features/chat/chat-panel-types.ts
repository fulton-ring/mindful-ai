import type {
  Conversation,
  EditProposal,
  Intervention,
  NoteState,
  Persona,
} from '@walden/contracts';

export type ChatPanelProps = {
  conversation: Conversation | null;
  scopeId: string | null;
  personas: Persona[];
  personaId: string;
  noteOpen: boolean;
  visible?: boolean;
  onPersona(id: string): void;
  onOpenNote(): void;
  onBranch?(id: string): void;
  onEnsureConversation(): Promise<Conversation>;
  /** A new user message is about to advance the conversation, expiring any
   *  undecided note proposal on the server. */
  onAdvance?(): void;
  onConversation(value: Conversation): void | Promise<void>;
  onFlush(): Promise<number | null | false>;
  onProposalStart(sourceId: string): void;
  onProposalCancelable(cancel: (() => Promise<NoteState | null>) | null): void;
  onProposalCancelled?(
    state: NoteState,
    conversationId: string,
    branchId: string,
  ): void | Promise<void>;
  onGhost(
    value: Extract<Intervention, { kind: 'ghost' }>['proposal'] | null,
    streaming: boolean,
    sourceId: string,
  ): void;
  onGhostBatch?(values: EditProposal[], sourceId: string): void;
};

export type ChatAction =
  | 'message'
  | 'challenge'
  | 'source'
  | 'capture'
  | 'feedback'
  | 'stop_checks';
