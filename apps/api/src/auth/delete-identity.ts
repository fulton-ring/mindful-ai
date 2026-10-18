import { createClerkClient } from '@clerk/backend';
import { HttpError } from '../http';
import type { Bindings } from '../types';
import { getAuth } from './better-auth';
/** Dispatch by the stored identity so absent provider secrets never silently skip deletion. */
export async function deleteAccountIdentity(
  env: Bindings,
  ownerId: string,
  fallbackSubject: string,
) {
  const identity = await env.DB.prepare('SELECT auth_provider,auth_subject FROM users WHERE id=?')
    .bind(ownerId)
    .first<{ auth_provider: string; auth_subject: string }>();
  if (!identity) return;
  try {
    switch (identity.auth_provider) {
      case 'none':
        return;
      case 'clerk':
        if (!env.CLERK_SECRET_KEY) throw new Error('Missing Clerk key');
        await createClerkClient({ secretKey: env.CLERK_SECRET_KEY }).users.deleteUser(
          identity.auth_subject || fallbackSubject,
        );
        return;
      case 'better-auth': {
        const context = await (await getAuth(env)).$context;
        await context.internalAdapter.deleteUserSessions(identity.auth_subject);
        await context.internalAdapter.deleteUser(identity.auth_subject);
        return;
      }
      default:
        throw new Error('Unknown authentication provider');
    }
  } catch {
    throw new HttpError(503, 'Identity deletion failed; deletion is pending and can be retried');
  }
}
