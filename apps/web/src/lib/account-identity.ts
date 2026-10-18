export const ACCOUNT_CHANGED_EVENT = 'walden:account-changed';
const changedMessage = 'Your account changed. Reload Walden before continuing.';
let accountId: string | null = null;
let invalidated = false;
let requests = new AbortController();

/** A new application bootstrap starts one document-bound identity session. */
export function beginIdentitySession() {
  requests.abort();
  accountId = null;
  invalidated = false;
  requests = new AbortController();
}
export function invalidateAccountIdentity() {
  if (invalidated) return;
  invalidated = true;
  requests.abort(new Error(changedMessage));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ACCOUNT_CHANGED_EVENT));
}
/** Changing accounts requires a reload; old queued callbacks can never inherit a new account. */
export function bindAccountIdentity(value: string): boolean {
  if (invalidated) return false;
  if (accountId && accountId !== value) {
    invalidateAccountIdentity();
    return false;
  }
  accountId = value;
  return true;
}
export function identityRequestScope(signal?: AbortSignal) {
  if (invalidated) throw new Error(changedMessage);
  return {
    accountId,
    signal: signal ? AbortSignal.any([signal, requests.signal]) : requests.signal,
  };
}
export function checkIdentityFailure(body: unknown) {
  const code = (body as { details?: { code?: string } } | null)?.details?.code;
  if (code === 'auth_identity_changed') invalidateAccountIdentity();
}
