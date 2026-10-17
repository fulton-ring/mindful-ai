import type { Agent } from '@mastra/core/agent';
import {
  AGENT_STREAM_TOPIC,
  DurableAgent,
  type DurableAgentStreamOptions,
  deleteRunRegistryEntry,
} from '@mastra/core/agent/durable';
import type { MastraServerCache } from '@mastra/core/cache';
import type { PubSub } from '@mastra/core/events';
import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore, type WorkflowsStorage } from '@mastra/core/storage';
import { ApplicationWorkflows } from './application-workflows';
import { withApplicationExecution } from './write-guard';

/** Platform adapters supply persistence; both hosts run this same native agent. */
export type NativeExecutionHost = {
  storage: MastraCompositeStore;
  cache: MastraServerCache;
  pubsub?: PubSub;
};
export type NativeExecutionContext = {
  host: NativeExecutionHost;
  runId: string;
  recover: boolean;
  generation: number;
  claimed?: boolean;
  model?: string;
  onClaim?: (failure?: boolean) => Promise<void>;
  beforeStart?: () => Promise<void>;
  shutdown?: () => Promise<void>;
  draining?: boolean;
  releaseOwnership?: () => Promise<void>;
};

class BorrowedTurnStore extends MastraCompositeStore {
  override async close() {
    /* Host shutdown owns the shared clients. */
  }
}

function borrowPubsub(pubsub: PubSub | undefined) {
  return (
    pubsub &&
    new Proxy(pubsub, {
      get(target, key) {
        if (key === 'close') return async () => {};
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    })
  );
}

export const EXECUTION_RETENTION_MS = 60 * 60_000;

async function claimTerminal(
  workflows: WorkflowsStorage,
  appWorkflows: ApplicationWorkflows,
  execution: NativeExecutionContext,
) {
  const claim = await appWorkflows.claimRunOwnership({
    runId: execution.runId,
    ownerId: crypto.randomUUID(),
    leaseMs: 30_000,
  });
  if (!claim.acquired)
    throw Object.assign(new Error('The turn still has a healthy native owner'), {
      id: 'DURABLE_AGENT_RUN_ACTIVE',
    });
  const fence = {
    runId: execution.runId,
    ownerId: claim.record.ownerId,
    generation: claim.record.generation,
  };
  const heartbeat = setInterval(() => {
    void workflows.renewRunOwnership({ ...fence, leaseMs: 30_000 }).catch(() => undefined);
  }, 10_000);
  execution.releaseOwnership = async () => {
    clearInterval(heartbeat);
    await workflows.releaseRunOwnership(fence);
  };
}

/** Setup can fail before DurableAgent exists; failures still need both ownership fences. */
export async function claimNativeFinalization(execution: NativeExecutionContext) {
  const workflows = await execution.host.storage.getStore('workflows');
  if (!workflows) throw new Error('Native workflow persistence is not configured');
  const appWorkflows = new ApplicationWorkflows(workflows, async () => {
    await execution.onClaim?.(true);
  });
  await claimTerminal(workflows, appWorkflows, execution);
  execution.claimed = true;
}

/** Reconstruct request-local tools and processors before invoking native recovery. */
async function streamNativeAgent(
  agent: Agent,
  messages: Parameters<Agent['stream']>[0],
  options: DurableAgentStreamOptions,
  execution: NativeExecutionContext,
) {
  const pubsub = borrowPubsub(execution.host.pubsub);
  const durable = new DurableAgent({
    agent,
    cache: execution.host.cache,
    pubsub,
    cleanupTimeoutMs: 0,
    maxSteps: 16,
  });
  const register = durable.runRegistry.registerWithMessageList.bind(durable.runRegistry);
  durable.runRegistry.registerWithMessageList = (runId, entry, messageList, memoryInfo) => {
    if (options.stopWhen) entry.stopWhen = options.stopWhen;
    return register(runId, entry, messageList, memoryInfo);
  };
  const workflows = await execution.host.storage.getStore('workflows');
  if (!workflows) throw new Error('Native workflow persistence is not configured');
  const appWorkflows = new ApplicationWorkflows(workflows, async () => {
    await execution.onClaim?.();
    await execution.beforeStart?.();
    execution.claimed = true;
  });
  const mastra = new Mastra({
    agents: { turn: durable },
    storage: new BorrowedTurnStore({
      id: `turn:${execution.runId}`,
      default: execution.host.storage,
      domains: { workflows: appWorkflows },
    }),
    pubsub,
    logger: false,
    recovery: { durableAgents: 'auto' },
  });
  execution.shutdown = () => mastra.shutdown({ drainTimeout: 5_000 });
  const snapshot = execution.recover
    ? await workflows?.loadWorkflowSnapshot({
        workflowName: 'durable-agentic-loop',
        runId: execution.runId,
      })
    : null;
  const { CachingPubSub } = await import('@mastra/core/events');
  const history =
    execution.recover && durable.pubsub instanceof CachingPubSub
      ? await durable.pubsub.getHistory(AGENT_STREAM_TOPIC(execution.runId))
      : [];
  const terminal =
    snapshot?.status !== 'running' &&
    snapshot?.status !== 'pending' &&
    history.some((event) => ['finish', 'error', 'abort'].includes(event.type));
  if (terminal) await claimTerminal(workflows, appWorkflows, execution);
  const response = await (terminal
    ? durable.observe(execution.runId)
    : snapshot
      ? durable.recover(execution.runId, { abortSignal: options.abortSignal })
      : durable.stream(messages, { ...options, runId: execution.runId })
  ).catch(async (error) => {
    await mastra.shutdown({ drainTimeout: 0 });
    throw error;
  });
  return {
    ...response,
    // Never call response.cleanup() here: it deletes persisted replay events.
    async release() {
      if ('detach' in response && typeof response.detach === 'function') await response.detach();
      await mastra.shutdown({ drainTimeout: 1_000 });
      durable.runRegistry.cleanup(execution.runId);
      deleteRunRegistryEntry(execution.runId, mastra);
    },
  };
}

export function nativeAgentStream(
  agent: Agent,
  messages: Parameters<Agent['stream']>[0],
  options: DurableAgentStreamOptions,
  execution: NativeExecutionContext,
) {
  return withApplicationExecution(execution, () =>
    streamNativeAgent(agent, messages, options, execution),
  );
}
