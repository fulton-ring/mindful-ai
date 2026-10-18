import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
/** Async Docker calls keep Vitest's worker RPC responsive during slow daemon operations. */
export async function dockerTestCommand(args: string[], timeout = 60000): Promise<string> {
  return (await execute('docker', args, { timeout })).stdout;
}
export async function dockerTestPort(name: string, port: number): Promise<string> {
  const mapping = await dockerTestCommand(['port', name, `${port}/tcp`]);
  const assigned = mapping.trim().match(/:(\d+)$/)?.[1];
  if (!assigned) throw new Error(`Disposable container ${name} has no published port ${port}`);
  return assigned;
}
async function removeContainer(name: string) {
  try {
    await dockerTestCommand(['rm', '-f', name], 15000);
  } catch (error) {
    const names = await dockerTestCommand(
      ['ps', '-a', '--filter', `name=${name}`, '--format', '{{.Names}}'],
      5000,
    );
    if (names.trim().split('\n').includes(name)) throw error;
  }
}
export async function removeTestContainers(names: string[]) {
  const results = await Promise.allSettled(names.map(removeContainer));
  const failures = results
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length)
    throw new AggregateError(failures, 'Disposable test container cleanup failed');
}
