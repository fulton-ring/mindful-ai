import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import type { Bindings } from '../../types';
import { runChatTurn } from './workflow-runner';

export class ChatWorkflow extends WorkflowEntrypoint<Bindings, { turnId: string }> {
  run(event: WorkflowEvent<{ turnId: string }>, step: WorkflowStep) {
    return runChatTurn(this.env, event.payload.turnId, step);
  }
}
