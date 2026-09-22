import { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import type { EditProposal, Message, NoteProposalEvent } from '@walden/contracts';
import { isRedundantAddition } from '@walden/domain';
import { z } from 'zod';
import { aiProviderErrorMessage } from '../../services/ai-errors/ai-errors';
import type { AgentTurnInput } from '../../services/types';
import { stableId } from '../interventions';
import type { AgentTraceContext } from '../stream-events';
import {
  type NoteProposalCandidate,
  noteProposalBatchOutputSchema,
  noteProposalNoopSchema,
  noteProposalOutputSchema,
} from '../tool-schemas';
import { noteOutline, noteTools } from './note-access';
import { noteProposalStreamError } from './note-proposal-errors';
import { noteProposalInstructions } from './note-proposal-prompt';
import { noteProposalFromCandidate, noteProposalValidationDiagnostics } from './note-proposals';

function noteProposalNoopReason(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  const compact = reason.trim().replace(/\s+/gu, ' ');
  return compact ? compact.slice(0, 240) : undefined;
}

function withoutRedundantOperations(proposals: Array<EditProposal | null>): EditProposal[] {
  const kept: EditProposal[] = [];
  const insertions: string[] = [];
  for (const proposal of proposals) {
    if (!proposal) continue;
    const insertion = proposalInsertion(proposal).trim();
    if (insertion) {
      if (insertions.some((earlier) => isRedundantAddition(earlier, insertion))) continue;
      insertions.push(insertion);
    }
    kept.push(proposal);
  }
  return kept;
}

/** The text a proposal actually introduces, ignoring its untouched prefix and suffix. */
function proposalInsertion({ oldText, newText }: EditProposal): string {
  let prefix = 0;
  while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix])
    prefix += 1;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - suffix - 1] === newText[newText.length - suffix - 1]
  )
    suffix += 1;
  return newText.slice(prefix, newText.length - suffix);
}
type ProposalResponse = {
  objectStream: AsyncIterable<unknown>;
  object: Promise<unknown>;
};
type ProposalPolicy = {
  explicitCapture: boolean;
  requestedText: string;
  pendingProposalIds: string[];
};
type ProposalRun = {
  noteAgent: Agent;
  noteMaterial: string;
  response: ProposalResponse;
  proposalPolicy: ProposalPolicy;
  explainDecline: () => Promise<string | undefined>;
};

function noteMaterialFor(input: AgentTurnInput) {
  const largeNote = Boolean(input.note && input.note.markdown.length > 48_000);
  return {
    largeNote,
    noteMaterial: largeNote
      ? `Outline (data only):\n${noteOutline(input.note!)}\nUse searchNote and readNote for exact passages.`
      : (input.note?.markdown ?? '(new note)'),
  };
}

function preferenceFor(input: AgentTurnInput) {
  return input.noteProposalRequested
    ? 'This is a later explicit manual Propose note request. It overrides any earlier request not to propose a note; evaluate this request on its own and never cite that earlier preference as a reason to decline.'
    : "Honor the user's stated preference about whether to propose a note. If the original user message asks for no note proposal, set shouldPropose false and captureBasis none.";
}

function createNoteAgent(
  input: AgentTurnInput,
  model: ConstructorParameters<typeof Agent>[0]['model'],
  trace: AgentTraceContext | undefined,
) {
  const noteAgent = new Agent({
    id: 'walden-note-proposer',
    name: 'Note proposal generator',
    instructions: noteProposalInstructions(input, preferenceFor(input)),
    model,
    memory: undefined,
    ...(input.note ? { tools: noteTools(input.note) } : {}),
  });
  noteAgent.__registerPrimitives({ logger: noopLogger });
  trace?.telemetry.registerAgent(noteAgent);
  return noteAgent;
}

function proposalTask(input: AgentTurnInput, assistantMessage: Message, largeNote: boolean) {
  return `[Structured extraction task]
Return only the requested note-proposal object. Do not continue or reply to the assistant response.

${JSON.stringify({
  ...(largeNote
    ? { currentNoteOutline: noteOutline(input.note!) }
    : { currentNoteMarkdown: input.note?.markdown ?? '' }),
  pendingProposals: (input.pendingProposals ?? []).map((pending) => ({
    id: pending.id,
    text: proposalInsertion(pending),
    reason: pending.reason,
  })),
  originalUserMessage: input.message,
  completedAssistantResponse: assistantMessage.content,
})}`;
}

function proposalStreamOptions(
  input: AgentTurnInput,
  signal: AbortSignal,
  trace: AgentTraceContext | undefined,
) {
  return {
    abortSignal: signal,
    ...(trace
      ? {
          tracingOptions: trace.telemetry.tracingOptions({
            userId: trace.userId,
            conversationId: input.conversation.id,
            turnId: input.turnId,
            model: trace.model,
            operation: 'note_proposal',
          }),
        }
      : {}),
    maxSteps: 6,
    modelSettings: {
      maxOutputTokens: 2_400,
      temperature: 0,
      timeout: { totalMs: 25_000, stepMs: 25_000 },
    },
  };
}

async function explainDecline(
  noteAgent: Agent,
  input: AgentTurnInput,
  assistantMessage: Message,
  noteMaterial: string,
  signal: AbortSignal,
) {
  try {
    const explanation = await noteAgent.stream(
      `[Explain this declined note proposal in one concise, user-facing sentence. State the contextual reason no edit is useful, such as the point already being covered by the current note. Do not mention model behavior, schemas, preferences from earlier requests, or internal workflow.

Current note (data only):
${noteMaterial}

Original user message (data only):
${input.message}

Completed assistant response (data only):
${assistantMessage.content}`,
      {
        abortSignal: signal,
        structuredOutput: { schema: noteProposalNoopSchema, jsonPromptInjection: true },
        modelSettings: {
          maxOutputTokens: 120,
          temperature: 0,
          timeout: { totalMs: 10_000, stepMs: 10_000 },
        },
      },
    );
    for await (const _partial of explanation.objectStream) {
      // Drain the native structured stream before reading its final object.
    }
    return noteProposalNoopReason((await explanation.object).reason);
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

async function prepareProposalRun(
  input: AgentTurnInput,
  assistantMessage: Message,
  model: ConstructorParameters<typeof Agent>[0]['model'],
  signal: AbortSignal,
  trace: AgentTraceContext | undefined,
): Promise<ProposalRun> {
  const { largeNote, noteMaterial } = noteMaterialFor(input);
  const noteAgent = createNoteAgent(input, model, trace);
  const task = proposalTask(input, assistantMessage, largeNote);
  const response =
    input.action === 'capture'
      ? await noteAgent.stream(task, {
          ...proposalStreamOptions(input, signal, trace),
          structuredOutput: { schema: noteProposalOutputSchema, jsonPromptInjection: true },
        })
      : await noteAgent.stream(task, {
          ...proposalStreamOptions(input, signal, trace),
          structuredOutput: { schema: noteProposalBatchOutputSchema, jsonPromptInjection: true },
        });
  const proposalPolicy = {
    explicitCapture: input.action === 'capture',
    requestedText: input.message,
    pendingProposalIds: (input.pendingProposals ?? []).map((pending) => pending.id),
  };
  return {
    noteAgent,
    noteMaterial,
    response,
    proposalPolicy,
    explainDecline: () => explainDecline(noteAgent, input, assistantMessage, noteMaterial, signal),
  };
}

function previewCandidate(
  partialCandidate: Partial<NoteProposalCandidate>,
  input: AgentTurnInput,
  proposalPolicy: ProposalPolicy,
  operationIndex: number,
): EditProposal | null {
  const candidate =
    proposalPolicy.explicitCapture &&
    partialCandidate.shouldPropose === true &&
    partialCandidate.captureBasis &&
    partialCandidate.captureBasis !== 'none' &&
    partialCandidate.mode === 'add'
      ? { ...partialCandidate, oldText: '', newText: input.message }
      : partialCandidate;
  const proposal = noteProposalFromCandidate(
    input.note,
    input.turnId,
    candidate,
    false,
    proposalPolicy,
  );
  if (!proposal || proposalPolicy.explicitCapture) return proposal;
  return { ...proposal, id: stableId('edit', input.turnId, String(operationIndex)) };
}

async function* partialPreviewEvents(
  partial: unknown,
  input: AgentTurnInput,
  proposalPolicy: ProposalPolicy,
  previousPreviews: Map<number, string>,
): AsyncGenerator<NoteProposalEvent> {
  const partialRecord = partial as Partial<z.infer<typeof noteProposalBatchOutputSchema>> &
    Partial<NoteProposalCandidate>;
  const candidates = proposalPolicy.explicitCapture
    ? [partialRecord]
    : (partialRecord.operations ??
      (partialRecord.shouldPropose === undefined ? [] : [partialRecord]));
  for (const [operationIndex, partialCandidate] of candidates.entries()) {
    const proposal = previewCandidate(partialCandidate, input, proposalPolicy, operationIndex);
    if (!proposal) continue;
    const signature = proposal.oldText + '\u0000' + proposal.newText + '\u0000' + proposal.reason;
    if (signature === previousPreviews.get(operationIndex)) continue;
    previousPreviews.set(operationIndex, signature);
    yield {
      type: 'preview',
      proposal,
      ...(proposalPolicy.explicitCapture ? {} : { operationIndex }),
    };
  }
}

async function* streamProposalPreviews(
  response: ProposalResponse,
  input: AgentTurnInput,
  proposalPolicy: ProposalPolicy,
  previousPreviews: Map<number, string>,
): AsyncGenerator<NoteProposalEvent> {
  for await (const partial of response.objectStream)
    yield* partialPreviewEvents(partial, input, proposalPolicy, previousPreviews);
}

type BatchState = {
  proposals: Array<EditProposal | null>;
  declinedReason: string | undefined;
  invalidIndexes: number[];
  unchangedIndexes: number[];
};

function batchState(
  finalOutput: NoteProposalCandidate & z.infer<typeof noteProposalBatchOutputSchema>,
  input: AgentTurnInput,
  proposalPolicy: ProposalPolicy,
): BatchState {
  const operations = finalOutput.operations ?? [];
  const proposals = operations.map((candidate, operationIndex) => {
    const proposal = noteProposalFromCandidate(
      input.note,
      input.turnId,
      candidate,
      true,
      proposalPolicy,
    );
    return proposal
      ? { ...proposal, id: stableId('edit', input.turnId, String(operationIndex)) }
      : null;
  });
  const declinedIndexes = operations.flatMap((candidate, index) =>
    candidate.shouldPropose === false ? [index] : [],
  );
  const declinedReason = declinedIndexes
    .map((index) => noteProposalNoopReason(operations[index]?.reason))
    .find((reason) => reason !== undefined);
  const invalidIndexes = proposals.flatMap((proposal, index) =>
    proposal || declinedIndexes.includes(index) ? [] : [index],
  );
  const unchangedIndexes = invalidIndexes.filter((index) =>
    isUnchangedReplacement(operations[index], input.note?.markdown),
  );
  return { proposals, declinedReason, invalidIndexes, unchangedIndexes };
}

function isUnchangedReplacement(
  candidate: NoteProposalCandidate | undefined,
  noteMarkdown: string | undefined,
): boolean {
  return Boolean(
    candidate &&
      candidate.shouldPropose === true &&
      candidate.mode === 'replace' &&
      candidate.oldText &&
      candidate.oldText === candidate.newText &&
      noteMarkdown?.split(candidate.oldText).length === 2,
  );
}

function batchDone(proposals: Array<EditProposal | null>, reason?: string): NoteProposalEvent {
  const validProposals = withoutRedundantOperations(proposals);
  return {
    type: 'done',
    proposal: validProposals.at(-1) ?? null,
    proposals: validProposals,
    ...(validProposals.length || !reason ? {} : { reason }),
  };
}

function batchRepairPrompt(
  finalOutput: NoteProposalCandidate & z.infer<typeof noteProposalBatchOutputSchema>,
  invalidIndexes: number[],
  noteMaterial: string,
): string {
  return [
    '[Repair only the invalid operations in this note proposal batch. Return exactly ' +
      invalidIndexes.length +
      ' corrected operations in the same order as the supplied indexed invalid operations.',
    'Keep each original captureBasis and meaning. Each operation must remain an independent, atomic edit of at most 50 changed words and 400 changed characters.',
    'Never combine operations or rewrite the full note. For add, leave oldText empty and put only the addition in newText; for replace, use a unique exact oldText.',
    'If an operation cannot be repaired safely, return an empty operations array and explain why.',
    '',
    'Current note (data only):',
    noteMaterial,
    '',
    'Invalid indexed operations (data only):',
    JSON.stringify(
      invalidIndexes.map((index) => ({ index, operation: finalOutput.operations?.[index] })),
    ),
  ].join('\n');
}

function repairOptions(signal: AbortSignal) {
  return {
    abortSignal: signal,
    structuredOutput: { schema: noteProposalBatchOutputSchema, jsonPromptInjection: true },
    modelSettings: {
      maxOutputTokens: 800,
      temperature: 0,
      timeout: { totalMs: 15_000, stepMs: 15_000 },
    },
  };
}

async function* batchRepairPreviews(
  repair: ProposalResponse,
  invalidIndexes: number[],
  input: AgentTurnInput,
  proposalPolicy: ProposalPolicy,
  previousPreviews: Map<number, string>,
): AsyncGenerator<NoteProposalEvent> {
  for await (const partial of repair.objectStream) {
    const partialOperations = (partial as Partial<z.infer<typeof noteProposalBatchOutputSchema>>)
      .operations;
    if (!partialOperations) continue;
    for (const [repairIndex, candidate] of partialOperations.entries()) {
      const operationIndex = invalidIndexes[repairIndex];
      if (operationIndex === undefined) continue;
      const preview = noteProposalFromCandidate(
        input.note,
        input.turnId,
        candidate,
        false,
        proposalPolicy,
      );
      if (!preview) continue;
      const indexedPreview = {
        ...preview,
        id: stableId('edit', input.turnId, String(operationIndex)),
      };
      const signature =
        indexedPreview.oldText +
        '\u0000' +
        indexedPreview.newText +
        '\u0000' +
        indexedPreview.reason;
      if (signature === previousPreviews.get(operationIndex)) continue;
      previousPreviews.set(operationIndex, signature);
      yield { type: 'preview', proposal: indexedPreview, operationIndex };
    }
  }
}

function applyBatchRepair(
  repaired: z.infer<typeof noteProposalBatchOutputSchema>,
  state: BatchState,
  invalidIndexes: number[],
  input: AgentTurnInput,
  proposalPolicy: ProposalPolicy,
): string | undefined {
  const repairedOperations = repaired.operations ?? [];
  if (repairedOperations.length === 0) return noteProposalNoopReason(repaired.reason);
  if (repairedOperations.length !== invalidIndexes.length) {
    console.warn('Note proposal batch repair count mismatch', {
      expectedCount: invalidIndexes.length,
      actualCount: repairedOperations.length,
      hasBatchReason: Boolean(noteProposalNoopReason(repaired.reason)),
    });
    return undefined;
  }
  for (const [repairIndex, candidate] of repairedOperations.entries()) {
    const operationIndex = invalidIndexes[repairIndex];
    if (operationIndex === undefined) continue;
    const proposal = noteProposalFromCandidate(
      input.note,
      input.turnId,
      candidate,
      true,
      proposalPolicy,
    );
    state.proposals[operationIndex] = proposal
      ? { ...proposal, id: stableId('edit', input.turnId, String(operationIndex)) }
      : null;
  }
  if (invalidIndexes.some((index) => !state.proposals[index]))
    console.warn('Note proposal batch repair validation failed', {
      operationCount: repairedOperations.length,
      hasBatchReason: Boolean(noteProposalNoopReason(repaired.reason)),
      invalidOperations: repairedOperations.map((candidate) =>
        noteProposalValidationDiagnostics(input.note, candidate, proposalPolicy),
      ),
    });
  return undefined;
}

async function* repairBatchProposal(
  finalOutput: NoteProposalCandidate & z.infer<typeof noteProposalBatchOutputSchema>,
  state: BatchState,
  input: AgentTurnInput,
  noteAgent: Agent,
  noteMaterial: string,
  signal: AbortSignal,
  proposalPolicy: ProposalPolicy,
  previousPreviews: Map<number, string>,
): AsyncGenerator<NoteProposalEvent, { declineReason: string | undefined }> {
  const { invalidIndexes } = state;
  try {
    const repair = await noteAgent.stream(
      batchRepairPrompt(finalOutput, invalidIndexes, noteMaterial),
      repairOptions(signal),
    );
    yield* batchRepairPreviews(repair, invalidIndexes, input, proposalPolicy, previousPreviews);
    return {
      declineReason: applyBatchRepair(
        (await repair.object) as z.infer<typeof noteProposalBatchOutputSchema>,
        state,
        invalidIndexes,
        input,
        proposalPolicy,
      ),
    };
  } catch (error) {
    if (signal.aborted || aiProviderErrorMessage(error)) throw error;
    console.warn('Note proposal batch repair failed', {
      name: error instanceof Error ? error.name : 'unknown',
      id: typeof error === 'object' && error && 'id' in error ? String(error.id) : undefined,
    });
    return { declineReason: undefined };
  }
}

async function* streamBatchProposal(
  finalOutput: NoteProposalCandidate & z.infer<typeof noteProposalBatchOutputSchema>,
  input: AgentTurnInput,
  noteAgent: Agent,
  noteMaterial: string,
  signal: AbortSignal,
  proposalPolicy: ProposalPolicy,
  previousPreviews: Map<number, string>,
  explainDecline: () => Promise<string | undefined>,
): AsyncGenerator<NoteProposalEvent> {
  if (proposalPolicy.explicitCapture || !Array.isArray(finalOutput.operations)) return;
  if (finalOutput.operations.length === 0) {
    const reason = noteProposalNoopReason(finalOutput.reason) ?? (await explainDecline());
    yield {
      type: 'done',
      proposal: null,
      proposals: [],
      reason: reason ?? 'No useful note update was found.',
    };
    return;
  }
  const state = batchState(finalOutput, input, proposalPolicy);
  if (
    state.invalidIndexes.length &&
    state.unchangedIndexes.length === state.invalidIndexes.length
  ) {
    const validProposals = withoutRedundantOperations(state.proposals);
    yield {
      type: 'done',
      proposal: validProposals.at(-1) ?? null,
      proposals: validProposals,
      ...(validProposals.length
        ? {}
        : { reason: (await explainDecline()) ?? 'The note already includes this update.' }),
    };
    return;
  }
  let repairDeclineReason: string | undefined;
  if (state.invalidIndexes.length) {
    console.warn('Note proposal batch validation failed', {
      operationCount: finalOutput.operations.length,
      invalidIndexes: state.invalidIndexes,
      invalidOperations: state.invalidIndexes.map((index) =>
        noteProposalValidationDiagnostics(
          input.note,
          finalOutput.operations?.[index] ?? {},
          proposalPolicy,
        ),
      ),
    });
    const repairStream = repairBatchProposal(
      finalOutput,
      state,
      input,
      noteAgent,
      noteMaterial,
      signal,
      proposalPolicy,
      previousPreviews,
    );
    let repairStep = await repairStream.next();
    while (!repairStep.done) {
      yield repairStep.value;
      repairStep = await repairStream.next();
    }
    repairDeclineReason = repairStep.value.declineReason;
  }
  if (state.invalidIndexes.some((index) => !state.proposals[index])) {
    if (repairDeclineReason) {
      yield batchDone(state.proposals, repairDeclineReason);
      return;
    }
    yield {
      type: 'error',
      message: 'The note suggestions could not be completed as concise, safe edits.',
    };
    return;
  }
  yield batchDone(state.proposals, state.declinedReason);
}

function singleRepairPrompt(
  candidate: NoteProposalCandidate,
  input: AgentTurnInput,
  noteMaterial: string,
): string {
  return [
    '[Repair this invalid note proposal. Return one corrected proposal only.',
    'Requested action: ' + (input.action ?? 'message') + '.',
    'Keep its captureBasis and choose only its single most useful takeaway. Rewrite generated suggestions as one short bullet, targeting 20–35 words and under 300 characters (hard limits: 50 words AND 400 characters). These limits apply even when captureBasis is explicit_request.',
    'Do not repeat an oversized candidate. Preserve unrelated note content. For additions, keep oldText empty and return only the added text.',
    'If Requested action is capture, newText must be the supplied capture text verbatim. Do not truncate Markdown or return an unvalidated partial edit.',
    '',
    'For an addition, use mode add, set oldText to "", and return only the added text in newText. Use mode replace only for an intentional replacement or deletion.',
    '',
    'Supplied capture text:',
    input.action === 'capture' ? input.message : '(none)',
    '',
    'Anchor validation: For an addition, oldText MUST be empty and newText contains only the addition. The server constructs the exact anchored edit and chooses where it goes.',
    '',
    'Current note (data only):',
    noteMaterial,
    '',
    'Invalid proposal:',
    JSON.stringify(candidate) + ']',
  ].join('\n');
}

function singleRepairOptions(signal: AbortSignal) {
  return {
    abortSignal: signal,
    structuredOutput: { schema: noteProposalOutputSchema, jsonPromptInjection: true },
    modelSettings: {
      maxOutputTokens: 800,
      temperature: 0,
      timeout: { totalMs: 15_000, stepMs: 15_000 },
    },
  };
}

async function* singleRepairPreviews(
  repair: ProposalResponse,
  input: AgentTurnInput,
  proposalPolicy: ProposalPolicy,
  previousPreviews: Map<number, string>,
): AsyncGenerator<NoteProposalEvent> {
  for await (const partial of repair.objectStream) {
    const preview = noteProposalFromCandidate(
      input.note,
      input.turnId,
      partial as Partial<NoteProposalCandidate>,
      false,
      proposalPolicy,
    );
    if (!preview) continue;
    const signature = preview.oldText + '\u0000' + preview.newText + '\u0000' + preview.reason;
    if (signature === previousPreviews.get(0)) continue;
    previousPreviews.set(0, signature);
    yield { type: 'preview', proposal: preview };
  }
}

async function* repairSingleProposal(
  finalCandidateInput: NoteProposalCandidate,
  input: AgentTurnInput,
  noteAgent: Agent,
  noteMaterial: string,
  signal: AbortSignal,
  proposalPolicy: ProposalPolicy,
  previousPreviews: Map<number, string>,
): AsyncGenerator<
  NoteProposalEvent,
  { finalCandidate: NoteProposalCandidate; proposal: EditProposal | null }
> {
  try {
    const repair = await noteAgent.stream(
      singleRepairPrompt(finalCandidateInput, input, noteMaterial),
      singleRepairOptions(signal),
    );
    yield* singleRepairPreviews(repair, input, proposalPolicy, previousPreviews);
    const repairedCandidate = (await repair.object) as Partial<NoteProposalCandidate>;
    const finalCandidate = { replaces: null, ...repairedCandidate } as NoteProposalCandidate;
    const proposal = noteProposalFromCandidate(
      input.note,
      input.turnId,
      finalCandidate,
      true,
      proposalPolicy,
    );
    if (!proposal && finalCandidate.shouldPropose && finalCandidate.captureBasis !== 'none')
      console.warn('Note proposal validation failed', {
        stage: 'repair',
        ...noteProposalValidationDiagnostics(input.note, finalCandidate, proposalPolicy),
        newWords: finalCandidate.newText?.trim().split(/\s+/u).length,
      });
    return { finalCandidate, proposal };
  } catch (error) {
    if (signal.aborted || aiProviderErrorMessage(error)) throw error;
    console.warn('Note proposal repair failed', {
      name: error instanceof Error ? error.name : 'unknown',
    });
    return { finalCandidate: finalCandidateInput, proposal: null };
  }
}

async function* streamSingleProposal(
  finalCandidateInput: NoteProposalCandidate,
  input: AgentTurnInput,
  noteAgent: Agent,
  noteMaterial: string,
  signal: AbortSignal,
  proposalPolicy: ProposalPolicy,
  previousPreviews: Map<number, string>,
): AsyncGenerator<NoteProposalEvent> {
  let finalCandidate = finalCandidateInput;
  let proposal = noteProposalFromCandidate(
    input.note,
    input.turnId,
    finalCandidate,
    true,
    proposalPolicy,
  );
  if (!proposal && finalCandidate.shouldPropose && finalCandidate.captureBasis !== 'none')
    console.warn('Note proposal validation failed', {
      stage: 'initial',
      ...noteProposalValidationDiagnostics(input.note, finalCandidate, proposalPolicy),
      newWords: finalCandidate.newText?.trim().split(/\s+/u).length,
    });
  const warrantsRepair =
    finalCandidate.shouldPropose === true &&
    Boolean(finalCandidate.captureBasis && finalCandidate.captureBasis !== 'none');
  if (!proposal && warrantsRepair) {
    const repairStream = repairSingleProposal(
      finalCandidate,
      input,
      noteAgent,
      noteMaterial,
      signal,
      proposalPolicy,
      previousPreviews,
    );
    let repairStep = await repairStream.next();
    while (!repairStep.done) {
      yield repairStep.value;
      repairStep = await repairStream.next();
    }
    finalCandidate = repairStep.value.finalCandidate;
    proposal = repairStep.value.proposal;
  }
  if (!proposal) {
    if (finalCandidate.shouldPropose !== true || finalCandidate.captureBasis === 'none') {
      yield {
        type: 'done',
        proposal: null,
        reason: noteProposalNoopReason(finalCandidate.reason),
      };
      return;
    }
    yield {
      type: 'error',
      message:
        'The note suggestion could not be completed as a concise, safe edit. Try selecting a smaller passage or a unique note location.',
    };
    return;
  }
  yield {
    type: 'done',
    proposal,
    ...(proposal ? {} : { reason: noteProposalNoopReason(finalCandidate.reason) }),
  };
}

async function* streamProposalBody(
  run: ProposalRun,
  input: AgentTurnInput,
  signal: AbortSignal,
): AsyncGenerator<NoteProposalEvent> {
  const { noteAgent, noteMaterial, response, proposalPolicy, explainDecline } = run;
  const previousPreviews = new Map<number, string>();
  yield* streamProposalPreviews(response, input, proposalPolicy, previousPreviews);
  const finalOutput = ((await response.object) ?? {}) as unknown as NoteProposalCandidate &
    z.infer<typeof noteProposalBatchOutputSchema>;
  if (!proposalPolicy.explicitCapture && Array.isArray(finalOutput.operations)) {
    yield* streamBatchProposal(
      finalOutput,
      input,
      noteAgent,
      noteMaterial,
      signal,
      proposalPolicy,
      previousPreviews,
      explainDecline,
    );
    return;
  }
  yield* streamSingleProposal(
    finalOutput,
    input,
    noteAgent,
    noteMaterial,
    signal,
    proposalPolicy,
    previousPreviews,
  );
}

export async function* streamNoteProposal(
  input: AgentTurnInput,
  assistantMessage: Message,
  model: ConstructorParameters<typeof Agent>[0]['model'],
  signal: AbortSignal,
  trace?: AgentTraceContext,
): AsyncIterable<NoteProposalEvent> {
  try {
    const run = await prepareProposalRun(input, assistantMessage, model, signal, trace);
    yield* streamProposalBody(run, input, signal);
  } catch (error) {
    yield noteProposalStreamError(error);
  }
}
