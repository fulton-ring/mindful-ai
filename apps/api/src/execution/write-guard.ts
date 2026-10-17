import { AsyncLocalStorage } from 'node:async_hooks';
import type { NativeExecutionContext } from './native-agent';

const executions = new AsyncLocalStorage<NativeExecutionContext>();
/** Carries the application generation into native background workflow/OM tasks. */
export const withApplicationExecution = <T>(execution: NativeExecutionContext, run: () => T): T =>
  executions.run(execution, run);

/** Atomic guard for D1 memory writes, whose store is separate from DO workflow ownership. */
export function applicationMemoryWriteGuard(): { sql: string; values: unknown[] } {
  const execution = executions.getStore();
  if (!execution) return { sql: '', values: [] };
  return {
    sql: ` AND EXISTS(SELECT 1 FROM turns t JOIN conversations c ON c.id=t.conversation_id
      JOIN conversation_branches b ON b.id=t.branch_id JOIN users u ON u.id=t.owner_id
      WHERE t.id=? AND t.execution_generation=? AND u.deletion_pending=0
      AND c.status='active' AND b.status='active' AND c.expires_at>?)`,
    values: [execution.runId, execution.generation, new Date().toISOString()],
  };
}
