import { Agent } from '@mastra/core/agent';
import { ToolCallFilter } from '@mastra/core/processors';
import { createTool } from '@mastra/core/tools';
import { createWorkspaceTools, type Workspace } from '@mastra/core/workspace';
import type { Memory } from '@mastra/memory';
import type { Intervention, WaldenUIMessageChunk } from '@walden/contracts';
import type { McpTools } from '../services/mcp';
import type { AgentTurnInput } from '../services/types';
import { type AgentCheckpoints, checkpointTools } from './checkpoints';
import { buildTurnContext, contextBudgetProcessor } from './context';
import { stableId, TurnProposals } from './interventions';
import {
  learningCheckIntervention,
  recoveredFrontendIntervention,
  standaloneLearningCheck,
  standaloneShortAnswerCheck,
} from './learning-checks';
import { noteTools } from './note-proposals/note-access';
import {
  CORE_INSTRUCTIONS,
  NO_RESEARCH_INSTRUCTIONS,
  personaInstructions,
  RESEARCH_INSTRUCTIONS,
  SAFETY_INSTRUCTIONS,
  WEB_SEARCH_INSTRUCTIONS,
} from './prompts';
import type { AgentTraceContext } from './stream-events';
import { askInputSchema, learningCheckInputSchema } from './tool-schemas';
import { agentUIChunks, newUIStreamState, type UIStreamState } from './ui-stream';

export type AgentRuntime = {
  memory?: { memory: Memory; threadId: string; resourceId: string };
  workspace?: Workspace;
  checkpoints?: AgentCheckpoints;
  onToolResult?: (name: string, result: unknown) => void;
};

function createPendingContext(input: AgentTurnInput) {
  if (input.pendingIntervention?.kind === 'learning_check')
    return `Pending learning check:\n${input.pendingIntervention.questions.map(({ id, question }) => `${id}: ${question}`).join('\n')}\nThe current user message contains the user's structured answers to this check. Give specific feedback on what was right, what needs correction, and one useful next step. Do not issue another check in this turn.`;
  if (input.pendingIntervention)
    return `Pending intervention kind: ${input.pendingIntervention.kind}.`;
  return 'Pending intervention: none.';
}

function createMastraTools(input: AgentTurnInput, tools: McpTools, proposals: TurnProposals) {
  return {
    ...tools,
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
  externalTools: McpTools,
  runtime: AgentRuntime,
  trace: AgentTraceContext | undefined,
  tools: ReturnType<typeof createMastraTools>,
) {
  const turnContext = buildTurnContext({
    memoryManaged: Boolean(runtime.memory),
    note: input.note,
    messages: input.conversation.messages,
    currentMessage: input.message,
    attachments: input.attachments,
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
      ...('readWebPage' in externalTools || 'searchSources' in externalTools
        ? [RESEARCH_INSTRUCTIONS]
        : []),
      ...('searchWeb' in externalTools ? [WEB_SEARCH_INSTRUCTIONS] : []),
      ...(input.conversation.webSearchEnabled === false
        ? [
            'Web search is disabled for this conversation. Do not search the public web. If fresh evidence is needed, explain that the user can enable Web search in Chat tools or supply a source URL. Do not claim to have searched.',
          ]
        : []),
      ...(!(
        'readWebPage' in externalTools ||
        'searchSources' in externalTools ||
        'searchWeb' in externalTools
      )
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
    maxSteps: 16,
    toolCallConcurrency: 1,
    modelSettings: { maxOutputTokens: 4_096 },
  };
}

function finalIntervention(
  input: AgentTurnInput,
  state: UIStreamState,
  proposals: TurnProposals,
): Intervention | undefined {
  const collected = proposals.drain().intervention;
  if (
    collected ||
    !input.conversation.learningChecksEnabled ||
    input.pendingIntervention ||
    input.action === 'stop_checks'
  )
    return collected;
  // A reply that is only a quiz becomes a learning check; its text is dropped on commit.
  return (
    standaloneLearningCheck(state.text, input.turnId) ??
    (state.quizToolCalled ? standaloneShortAnswerCheck(state.text, input.turnId) : null) ??
    undefined
  );
}

function assertCompleted(state: UIStreamState, intervention: Intervention | undefined) {
  if (state.lengthLimited)
    throw new Error('The response reached its output limit. Please try again.');
  if (!state.text.trim() && !intervention)
    throw new Error('The model completed without a visible response. Please try again.');
}

export type MastraTurnOptions = {
  input: AgentTurnInput;
  model: ConstructorParameters<typeof Agent>[0]['model'];
  signal: AbortSignal;
  /** MCP, research, web-search, and document tools offered to the agent. */
  tools?: McpTools;
  trace?: AgentTraceContext;
  runtime?: AgentRuntime;
};

export async function* streamMastraTurn({
  input,
  model,
  signal,
  tools = {},
  trace,
  runtime = {},
}: MastraTurnOptions): AsyncIterable<WaldenUIMessageChunk> {
  if (input.conversation.webSearchEnabled === false) {
    tools = { ...tools };
    delete tools.searchWeb;
  }
  if (runtime.checkpoints) {
    const workspaceTools = runtime.workspace ? await createWorkspaceTools(runtime.workspace) : {};
    runtime.workspace?.setToolsConfig({ enabled: false });
    tools = checkpointTools(
      { ...tools, ...workspaceTools },
      runtime.checkpoints,
      runtime.onToolResult,
    );
  }
  const proposals = new TurnProposals();
  const agentTools = createMastraTools(input, tools, proposals);
  const { agent, turnContext } = createMastraAgent(input, model, tools, runtime, trace, agentTools);
  const response = await agent.stream(
    turnContext.messages,
    responseOptions(input, signal, trace, runtime, turnContext, proposals),
  );
  const state = newUIStreamState();
  yield* agentUIChunks(response.fullStream, input.turnId, state, (call) => {
    const intervention = recoveredFrontendIntervention(
      call,
      input.turnId,
      input.conversation.learningChecksEnabled,
    );
    if (intervention) proposals.propose(intervention);
  });
  const intervention = finalIntervention(input, state, proposals);
  assertCompleted(state, intervention);
  if (intervention) yield { type: 'data-intervention', id: intervention.id, data: intervention };
}
