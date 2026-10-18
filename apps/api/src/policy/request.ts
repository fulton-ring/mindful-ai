import type { Context } from 'hono';
import type { Bindings, Variables } from '../types';
import { getAccountPolicy } from './index';

/** Resolve once per authenticated request, including retention and admission. */
export async function getRequestAccountPolicy(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
) {
  const existing = c.get('accountPolicy');
  if (existing) return existing;
  const account = await getAccountPolicy(c.env, c.get('userId'));
  c.set('accountPolicy', account);
  return account;
}
