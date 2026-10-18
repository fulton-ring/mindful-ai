import {
  type AccountPolicy,
  type AppPolicy,
  accountPolicySchema,
  DEFAULT_APP_POLICY,
} from '@walden/contracts';
import { useSyncExternalStore } from 'react';
import { ApiError, api } from './api';

const legacyPolicy: AccountPolicy = { planId: 'default', policy: DEFAULT_APP_POLICY };
let current: { identity: string | null; value: AccountPolicy } = {
  identity: null,
  value: legacyPolicy,
};
const listeners = new Set<() => void>();
export const accountPolicy = () => current;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function setAccountPolicy(identity: string, value: AccountPolicy) {
  current = { identity, value };
  for (const listener of listeners) listener();
}
export function clearAccountPolicy(identity?: string) {
  if (identity !== undefined && identity !== current.identity) return;
  current = { identity: null, value: legacyPolicy };
  for (const listener of listeners) listener();
}
export function useAccountPolicy() {
  return useSyncExternalStore(subscribe, accountPolicy).value.policy;
}
export function useAccountPolicySnapshot() {
  return useSyncExternalStore(subscribe, accountPolicy);
}
export async function loadAccountPolicy(): Promise<AccountPolicy> {
  try {
    const result = accountPolicySchema.safeParse(await api.accountPolicy());
    if (!result.success) throw new Error('The server returned invalid account settings.');
    return result.data;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return legacyPolicy;
    throw error;
  }
}
function bytesLabel(bytes: number) {
  if (bytes % 1_000_000 === 0) return `${bytes / 1_000_000} MB`;
  if (bytes % 1_000 === 0) return `${bytes / 1_000} KB`;
  return `${bytes.toLocaleString()} bytes`;
}
export function uploadPolicyError(
  files: { size: number }[],
  currentCount: number,
  policy: AppPolicy['uploads'],
): { message: string; code: string } | null {
  if (policy.maxFiles !== null && currentCount + files.length > policy.maxFiles)
    return {
      message: `Choose up to ${policy.maxFiles} ${policy.maxFiles === 1 ? 'file' : 'files'}.`,
      code: 'too_many_files',
    };
  if (files.some((file) => file.size === 0))
    return { message: 'Files cannot be empty.', code: 'file_size' };
  const maxBytes = policy.maxBytes;
  if (maxBytes !== null && files.some((file) => file.size > maxBytes))
    return {
      message: `Each file must be ${bytesLabel(maxBytes)} or smaller.`,
      code: 'file_size',
    };
  return null;
}
