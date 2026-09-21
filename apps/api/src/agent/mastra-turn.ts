import { Agent } from '@mastra/core/agent';
import { ToolCallFilter } from '@mastra/core/processors';
import type { ChunkType } from '@mastra/core/stream';
import { createTool } from '@mastra/core/tools';
import type { Workspace } from '@mastra/core/workspace';
import type { Memory } from '@mastra/memory';
import type {
  ChatEvent,
  Intervention,
  Message,
  MessageSource,
  ToolActivity,
} from '@walden/contracts';
import type { McpTools } from '../services/mcp';
import type { AgentTurnInput } from '../services/types';
import { buildTurnContext, contextBudgetProcessor } from './context';
import { stableId, TurnProposals } from './interventions';
import {
  GemmaToolLeakDecoder,
  learningCheckIntervention,
  recoveredFrontendIntervention,
  standaloneLearningCheck,
  standaloneShortAnswerCheck,
} from './learning-checks';
import { noteTools } from './note-access';
import {
  CORE_INSTRUCTIONS,
  NO_RESEARCH_INSTRUCTIONS,
  personaInstructions,
  RESEARCH_INSTRUCTIONS,
  SAFETY_INSTRUCTIONS,
  WEB_SEARCH_INSTRUCTIONS,
} from './prompts';
import { AgentTraceContext, isLengthLimitedFinalChunk, visibleStreamEvent } from './stream-events';
import { askInputSchema, learningCheckInputSchema } from './tool-schemas';

export type AgentRuntime = {
  memory?: { memory: Memory; threadId: string; resourceId: string };
  workspace?: Workspace;
};

type MastraResponse = Awaited<ReturnType<Agent['stream']>>;

type StreamState = {
  text: string;
  reasoning: string;
  lengthLimited: boolean;
  quizToolCalled: boolean;
  activityTools: Map<string, ToolActivity>;
  sources: Map<string, MessageSource>;
};

const SEARCH_FAILURE =
  'Web search failed. Please retry; this does not mean no matching reports exist.';

function safeToolName(name: string) {
  return name.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) || 'tool';
}

function toolSummary(name: string, state: ToolActivity['state']) {
  const searchSummary: Partial<Record<ToolActivity['state'], string>> = {
    running: 'Searching the web…',
    error: 'Web search failed',
  };
  if (name === 'searchWeb') return searchSummary[state] ?? '';
  const action = name === 'readWebPage' ? 'source' : name === 'searchSources' ? 'sources' : 'tool';
  const summaries: Record<string, Partial<Record<ToolActivity['state'], string>>> = {
    source: { running: 'Reading source…', error: 'Could not read source' },
    sources: { running: 'Searching sources…', error: 'Could not search sources' },
    tool: { running: 'Using tool…', error: 'Tool failed' },
  };
  return summaries[action]?.[state] ?? '';
}

function publicSource(
  sources: Map<string, MessageSource>,
  id: string,
  value: unknown,
  title?: unknown,
): MessageSource | null {
  if (typeof value !== 'string' || sources.size >= 20) return null;
  try {
    const url = new URL(value);
    const hostname = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '')
      .toLowerCase();
    const privateHost =
      !hostname.includes('.') ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.includes(':') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password ||
      privateHost
    )
      return null;
    url.hash = '';
    return {
      id: id.slice(0, 200),
      url: url.toString(),
      ...(typeof title === 'string' && title.trim() ? { title: title.trim().slice(0, 300) } : {}),
    };
  } catch {
    return null;
  }
}

function addSource(state: StreamState, source: MessageSource | null): ChatEvent[] {
  if (!source || state.sources.has(source.url)) return [];
  state.sources.set(source.url, source);
  return [{ type: 'source', source }];
}

function createPendingContext(input: AgentTurnInput) {
  if (input.pendingIntervention?.kind === 'learning_check')
    return `Pending learning check:\n${input.pendingIntervention.questions.map(({ id, question }) => `${id}: ${question}`).join('\n')}\nThe current user message contains the user's structured answers to this check. Give specific feedback on what was right, what needs correction, and one useful next step. Do not issue another check in this turn.`;
  if (input.pendingIntervention)
    return `Pending intervention kind: ${input.pendingIntervention.kind}.`;
  return 'Pending intervention: none.';
}

function createMastraTools(input: AgentTurnInput, mcpTools: McpTools, proposals: TurnProposals) {
  return {
    ...mcpTools,
    ...(input.note ? noteTools(input.note) : {}),
    proposeAsk: createTool({
      id: 'propose_ask',
      description:
        'Offer 2–4 concrete choices plus an implicit Other choice. This never writes notes.',
      inputSchema: askInputSchema,
      execute: async (context) =>
        proposals.propose({
          id: stableId('ask', input.turnId, context.question),
          kind: 'ask',
          question: context.question,
          options: context.options,
        }),
    }),
    proposeLearningCheck: createTool({
      id: 'propose_learning_check',
      description:
        'Use this whenever you decide to quiz. Request one to three short questions. Include 2–4 options for multiple choice; omit options for short answer. A short id and header help label each answer, but may be omitted. The client collects the answers in one focused UI. Put questions here, never in assistant text. Do not reveal answers before the user responds.',
      inputSchema: learningCheckInputSchema,
      execute: async (context) =>
        input.conversation.learningChecksEnabled
          ? proposals.propose(learningCheckIntervention(context, input.turnId))
          : { accepted: false, reason: 'The user has turned learning checks off for this thread.' },
    }),
  };
}

function createMastraAgent(
  input: AgentTurnInput,
  model: ConstructorParameters<typeof Agent>[0]['model'],
  mcpTools: McpTools,
  runtime: AgentRuntime,
  trace: AgentTraceContext | undefined,
  tools: ReturnType<typeof createMastraTools>,
) {
  const turnContext = buildTurnContext({
    memoryManaged: Boolean(runtime.memory),
    note: input.note,
    messages: input.conversation.messages,
    currentMessage: input.message,
    requestId: input.requestId,
    dynamicContext: `Requested action: ${input.action ?? 'message'}.\nLearning checks: ${input.conversation.learningChecksEnabled ? 'permitted, but judge whether one is warranted' : 'turned off by the user'}.\n${createPendingContext(input)}`,
  });
  const agent = new Agent({
    id: 'walden-thinking-partner',
    name: 'Walden thinking partner',
    instructions: [
      CORE_INSTRUCTIONS,
      SAFETY_INSTRUCTIONS,
      `Current date: ${new Date().toISOString().slice(0, 10)}.`,
      ...('readWebPage' in mcpTools || 'searchSources' in mcpTools ? [RESEARCH_INSTRUCTIONS] : []),
      ...('searchWeb' in mcpTools ? [WEB_SEARCH_INSTRUCTIONS] : []),
      ...(input.conversation.webSearchEnabled === false
        ? [
            'Web search is disabled for this conversation. Do not search the public web. If fresh evidence is needed, explain that the user can enable Web search in Chat tools or supply a source URL. Do not claim to have searched.',
          ]
        : []),
      ...(!('readWebPage' in mcpTools || 'searchSources' in mcpTools || 'searchWeb' in mcpTools)
        ? [NO_RESEARCH_INSTRUCTIONS]
        : []),
      personaInstructions(input.persona),
    ],
    model,
    tools: tools as ConstructorParameters<typeof Agent>[0]['tools'],
    inputProcessors: [new ToolCallFilter({ filterAfterToolSteps: 4 }), contextBudgetProcessor()],
    memory: runtime.memory?.memory,
    workspace: runtime.workspace,
  });
  trace?.telemetry.registerAgent(agent);
  return { agent, turnContext };
}

function responseOptions(
  input: AgentTurnInput,
  signal: AbortSignal,
  trace: AgentTraceContext | undefined,
  runtime: AgentRuntime,
  turnContext: ReturnType<typeof buildTurnContext>,
  proposals: TurnProposals,
) {
  return {
    abortSignal: signal,
    ...(runtime.memory
      ? {
          memory: {
            thread: runtime.memory.threadId,
            resource: runtime.memory.resourceId,
            options: { readOnly: true },
          },
        }
      : {}),
    ...(trace
      ? {
          tracingOptions: trace.telemetry.tracingOptions({
            userId: trace.userId,
            conversationId: input.conversation.id,
            turnId: input.turnId,
            model: trace.model,
            operation: 'chat',
          }),
        }
      : {}),
    context: turnContext.context,
    stopWhen: () => proposals.drain().intervention?.kind === 'learning_check',
    maxSteps: 7,
    toolCallConcurrency: 1,
    modelSettings: { maxOutputTokens: 4_096 },
  };
}

function queryFromToolCall(name: string, args: unknown) {
  if (
    (name !== 'searchWeb' && name !== 'searchSources') ||
    !args ||
    typeof args !== 'object' ||
    !('query' in args) ||
    typeof args.query !== 'string'
  )
    return undefined;
  return args.query.trim().slice(0, 500);
}

function toolCallEvents(
  chunk: Extract<ChunkType, { type: 'tool-call' }>,
  state: StreamState,
): ChatEvent[] {
  const { toolName: name, toolCallId, args } = chunk.payload;
  if (name === 'proposeLearningCheck') state.quizToolCalled = true;
  if (name === 'proposeAsk' || name === 'proposeLearningCheck' || state.activityTools.size >= 20)
    return toolStatusEvents(name);
  const query = queryFromToolCall(name, args);
  const tool: ToolActivity = {
    ...(query ? { query } : {}),
    id: toolCallId.slice(0, 200),
    name: safeToolName(name),
    state: 'running',
    summary: toolSummary(name, 'running'),
  };
  state.activityTools.set(tool.id, tool);
  return [{ type: 'tool', tool }, ...toolStatusEvents(name)];
}

function toolStatusEvents(name: string): ChatEvent[] {
  if (name === 'readWebPage') return [{ type: 'status', text: 'Reading source…' }];
  if (name === 'searchSources') return [{ type: 'status', text: 'Searching sources…' }];
  if (name === 'searchWeb') return [{ type: 'status', text: 'Searching the web…' }];
  return [];
}

function sourceResults(
  state: StreamState,
  toolName: string,
  toolCallId: string,
  result: object,
  tool: ToolActivity,
): ChatEvent[] {
  const found: MessageSource[] = [];
  addPageSource(found, state, toolName, toolCallId, result);
  addSearchSources(found, state, toolName, toolCallId, result);
  if (['searchWeb', 'searchSources', 'readWebPage'].includes(toolName)) tool.sources = found;
  return found.flatMap((source) => addSource(state, source));
}

function addPageSource(
  found: MessageSource[],
  state: StreamState,
  toolName: string,
  toolCallId: string,
  result: object,
) {
  if (toolName !== 'readWebPage' || !('url' in result)) return;
  const source = publicSource(state.sources, `${toolCallId}:0`, result.url);
  if (source) found.push(source);
}

function addSearchSources(
  found: MessageSource[],
  state: StreamState,
  toolName: string,
  toolCallId: string,
  result: object,
) {
  if (
    (toolName === 'searchSources' || toolName === 'searchWeb') &&
    'results' in result &&
    Array.isArray(result.results)
  )
    for (const [index, item] of result.results.slice(0, 20).entries()) {
      if (!item || typeof item !== 'object' || !('url' in item)) continue;
      const source = publicSource(
        state.sources,
        `${toolCallId}:${index}`,
        item.url,
        'title' in item ? item.title : undefined,
      );
      if (source && !found.some((previous) => previous.url === source.url)) found.push(source);
    }
}

function* toolResultEvents(
  chunk: Extract<ChunkType, { type: 'tool-result' }>,
  state: StreamState,
): Generator<ChatEvent> {
  const { toolCallId, toolName, result, isError } = chunk.payload;
  if (toolName === 'proposeAsk' || toolName === 'proposeLearningCheck') return;
  const toolFailed =
    isError ||
    (typeof result === 'object' && result !== null && 'error' in result && result.error === true);
  const prior = state.activityTools.get(toolCallId);
  const tool: ToolActivity = {
    ...(prior?.query ? { query: prior.query } : {}),
    id: toolCallId.slice(0, 200),
    name: safeToolName(toolName),
    state: toolFailed ? 'error' : 'complete',
    summary:
      !toolFailed &&
      toolName === 'readWebPage' &&
      result &&
      typeof result === 'object' &&
      'indexing' in result &&
      result.indexing &&
      typeof result.indexing === 'object' &&
      'status' in result.indexing &&
      result.indexing.status === 'failed'
        ? 'Read, but not saved to search'
        : toolSummary(toolName, toolFailed ? 'error' : 'complete'),
  };
  const events =
    !toolFailed && result && typeof result === 'object'
      ? sourceResults(state, toolName, toolCallId, result, tool)
      : [];
  if (prior || state.activityTools.size < 20) {
    state.activityTools.set(tool.id, tool);
    events.push({ type: 'tool', tool });
  }
  yield* events;
  if (toolName === 'searchWeb' && toolFailed) throw new Error(SEARCH_FAILURE);
}

function* toolErrorEvents(
  chunk: Extract<ChunkType, { type: 'tool-error' }>,
  state: StreamState,
): Generator<ChatEvent> {
  const { toolCallId, toolName } = chunk.payload;
  const tool: ToolActivity = {
    ...(state.activityTools.get(toolCallId)?.query
      ? { query: state.activityTools.get(toolCallId)!.query }
      : {}),
    id: toolCallId.slice(0, 200),
    name: safeToolName(toolName),
    state: 'error',
    summary: toolSummary(toolName, 'error'),
  };
  if (state.activityTools.has(tool.id) || state.activityTools.size < 20) {
    state.activityTools.set(tool.id, tool);
    yield { type: 'tool', tool };
  }
  if (toolName === 'searchWeb') throw new Error(SEARCH_FAILURE);
}

function recoveredEvents(
  event: Extract<ChatEvent, { type: 'text' | 'reasoning' }>,
  state: StreamState,
  leakedTools: GemmaToolLeakDecoder,
  proposals: TurnProposals,
  input: AgentTurnInput,
): ChatEvent[] {
  if (event.type !== 'text') {
    state.reasoning += event.text;
    return [event];
  }
  const decoded = leakedTools.push(event.text);
  for (const call of decoded.calls) {
    const intervention = recoveredFrontendIntervention(
      call,
      input.turnId,
      input.conversation.learningChecksEnabled,
    );
    if (intervention) proposals.propose(intervention);
  }
  if (!decoded.text) return [];
  state.text += decoded.text;
  return [{ type: 'text', text: decoded.text }];
}

function* toolChunkEvents(chunk: ChunkType, state: StreamState): Generator<ChatEvent> {
  if (chunk.type === 'tool-call') yield* toolCallEvents(chunk, state);
  if (chunk.type === 'tool-result') yield* toolResultEvents(chunk, state);
  if (chunk.type === 'tool-error') yield* toolErrorEvents(chunk, state);
}

function* sourceChunkEvents(chunk: ChunkType, state: StreamState): Generator<ChatEvent> {
  if (chunk.type !== 'source' || chunk.payload.sourceType !== 'url') return;
  yield* addSource(
    state,
    publicSource(state.sources, chunk.payload.id, chunk.payload.url, chunk.payload.title),
  );
}

function throwChunkError(chunk: ChunkType) {
  if (chunk.type !== 'error') return;
  throw chunk.payload.error instanceof Error
    ? chunk.payload.error
    : new Error('The model stream failed.');
}

async function* consumeMastraStream(
  response: MastraResponse,
  input: AgentTurnInput,
  proposals: TurnProposals,
): AsyncGenerator<ChatEvent, StreamState> {
  const state: StreamState = {
    text: '',
    reasoning: '',
    lengthLimited: false,
    quizToolCalled: false,
    activityTools: new Map(),
    sources: new Map(),
  };
  const leakedTools = new GemmaToolLeakDecoder();
  for await (const chunk of response.fullStream) {
    if (
      (chunk.type === 'finish' || chunk.type === 'step-finish') &&
      isLengthLimitedFinalChunk(chunk)
    )
      state.lengthLimited = true;
    yield* toolChunkEvents(chunk, state);
    yield* sourceChunkEvents(chunk, state);
    throwChunkError(chunk);
    const event = visibleStreamEvent(chunk);
    if (event) yield* recoveredEvents(event, state, leakedTools, proposals, input);
  }
  const trailingText = leakedTools.finish();
  if (trailingText) {
    state.text += trailingText;
    yield { type: 'text', text: trailingText };
  }
  const usage = await response.totalUsage;
  yield {
    type: 'usage',
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  };
  return state;
}

function finalIntervention(
  input: AgentTurnInput,
  state: StreamState,
  proposals: TurnProposals,
): { intervention?: Intervention; visibleText: string } {
  const collected = proposals.drain();
  let intervention = collected.intervention;
  let visibleText = state.text;
  if (
    !intervention &&
    input.conversation.learningChecksEnabled &&
    !input.pendingIntervention &&
    input.action !== 'stop_checks'
  ) {
    intervention =
      standaloneLearningCheck(state.text, input.turnId) ??
      (state.quizToolCalled ? standaloneShortAnswerCheck(state.text, input.turnId) : null) ??
      undefined;
    if (intervention) visibleText = '';
  }
  return { intervention, visibleText };
}

function doneEvent(
  input: AgentTurnInput,
  state: StreamState,
  intervention: Intervention | undefined,
  visibleText: string,
): ChatEvent {
  if (state.lengthLimited)
    throw new Error('The response reached its output limit. Please try again.');
  if (!visibleText.trim() && !intervention)
    throw new Error('The model completed without a visible response. Please try again.');
  const message: Message = {
    id: input.turnId,
    role: 'assistant',
    content: visibleText,
    ...(state.reasoning ? { reasoning: state.reasoning } : {}),
    createdAt: new Date().toISOString(),
    annotations: [],
    ...(state.activityTools.size ? { tools: [...state.activityTools.values()] } : {}),
    ...(state.sources.size ? { sources: [...state.sources.values()] } : {}),
    ...(intervention?.kind === 'learning_check' ? { learningCheck: intervention } : {}),
  };
  return {
    type: 'done',
    message,
    conversationId: input.conversation.id,
    branchId: input.conversation.branchId,
    title: input.conversation.title,
    expiresAt: input.conversation.expiresAt,
  };
}

export async function* streamMastraTurn(
  input: AgentTurnInput,
  model: ConstructorParameters<typeof Agent>[0]['model'],
  signal: AbortSignal,
  mcpTools: McpTools = {},
  trace?: AgentTraceContext,
  runtime: AgentRuntime = {},
): AsyncIterable<ChatEvent> {
  if (input.conversation.webSearchEnabled === false) {
    mcpTools = { ...mcpTools };
    delete mcpTools.searchWeb;
  }
  const proposals = new TurnProposals();
  const tools = createMastraTools(input, mcpTools, proposals);
  const { agent, turnContext } = createMastraAgent(input, model, mcpTools, runtime, trace, tools);
  const response = await agent.stream(
    turnContext.messages,
    responseOptions(input, signal, trace, runtime, turnContext, proposals),
  );
  const stream = consumeMastraStream(response, input, proposals);
  let next = await stream.next();
  while (!next.done) {
    yield next.value;
    next = await stream.next();
  }
  const { intervention, visibleText } = finalIntervention(input, next.value, proposals);
  if (intervention) yield { type: 'intervention', intervention };
  yield doneEvent(input, next.value, intervention, visibleText);
}
