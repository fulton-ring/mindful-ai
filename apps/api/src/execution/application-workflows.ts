import { resolveRunFence, WorkflowsStorage } from '@mastra/core/storage';

/** Acquire the application commit generation before native execution can start. */
export class ApplicationWorkflows extends WorkflowsStorage {
  private applicationClaim?: Promise<void>;
  constructor(
    private readonly inner: WorkflowsStorage,
    private readonly onClaim: () => Promise<void>,
  ) {
    super();
  }
  override init() {
    return this.inner.init();
  }
  supportsConcurrentUpdates() {
    return this.inner.supportsConcurrentUpdates();
  }
  override supportsRunFencing() {
    return this.inner.supportsRunFencing();
  }
  override async claimRunOwnership(args: Parameters<WorkflowsStorage['claimRunOwnership']>[0]) {
    const result = await this.inner.claimRunOwnership(args);
    if (result.acquired) {
      try {
        this.applicationClaim ??= this.onClaim();
        await this.applicationClaim;
      } catch (error) {
        await this.inner.releaseRunOwnership({
          runId: args.runId,
          generation: result.record.generation,
          ownerId: args.ownerId,
        });
        throw error;
      }
    }
    return result;
  }
  override renewRunOwnership(args: Parameters<WorkflowsStorage['renewRunOwnership']>[0]) {
    return this.inner.renewRunOwnership(args);
  }
  override releaseRunOwnership(args: Parameters<WorkflowsStorage['releaseRunOwnership']>[0]) {
    return this.inner.releaseRunOwnership(args);
  }
  override getRunOwnership(args: Parameters<WorkflowsStorage['getRunOwnership']>[0]) {
    return this.inner.getRunOwnership(args);
  }
  persistWorkflowSnapshot(args: Parameters<WorkflowsStorage['persistWorkflowSnapshot']>[0]) {
    return this.inner.persistWorkflowSnapshot({
      ...args,
      fence: resolveRunFence(this, args.fence, args.runId),
    });
  }
  updateWorkflowResults(args: Parameters<WorkflowsStorage['updateWorkflowResults']>[0]) {
    return this.inner.updateWorkflowResults({
      ...args,
      fence: resolveRunFence(this, args.fence, args.runId),
    });
  }
  updateWorkflowState(args: Parameters<WorkflowsStorage['updateWorkflowState']>[0]) {
    return this.inner.updateWorkflowState({
      ...args,
      fence: resolveRunFence(this, args.fence, args.runId),
    });
  }
  deleteWorkflowRunById(args: Parameters<WorkflowsStorage['deleteWorkflowRunById']>[0]) {
    return this.inner.deleteWorkflowRunById({
      ...args,
      fence: resolveRunFence(this, args.fence, args.runId),
    });
  }
  loadWorkflowSnapshot(args: Parameters<WorkflowsStorage['loadWorkflowSnapshot']>[0]) {
    return this.inner.loadWorkflowSnapshot(args);
  }
  getWorkflowRunById(args: Parameters<WorkflowsStorage['getWorkflowRunById']>[0]) {
    return this.inner.getWorkflowRunById(args);
  }
  listWorkflowRuns(args?: Parameters<WorkflowsStorage['listWorkflowRuns']>[0]) {
    return this.inner.listWorkflowRuns(args);
  }
  dangerouslyClearAll() {
    return this.inner.dangerouslyClearAll();
  }
}
