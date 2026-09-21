import type { NoteProposalEvent } from '@walden/contracts';
import { z } from 'zod';
import { aiProviderErrorMessage } from '../services/ai-errors';

export function noteProposalStreamError(error: unknown): NoteProposalEvent {
  console.warn('Note proposal stream failed', {
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof TypeError ? error.message.slice(0, 200) : undefined,
    code: typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined,
    status:
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined,
    causeName:
      error instanceof Error && error.cause instanceof Error ? error.cause.name : undefined,
    issues:
      error instanceof Error && error.cause instanceof z.ZodError
        ? error.cause.issues.map(({ path, code }) => ({ path: path.join('.'), code }))
        : undefined,
  });
  return {
    type: 'error',
    message:
      error instanceof Error && error.name === 'AbortError'
        ? 'Note proposal generation was cancelled.'
        : (aiProviderErrorMessage(error) ?? 'Note proposal generation failed.'),
  };
}
