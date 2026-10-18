import { DEFAULT_APP_POLICY } from '@walden/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import {
  accountPolicy,
  clearAccountPolicy,
  loadAccountPolicy,
  setAccountPolicy,
  uploadPolicyError,
} from '../account-policy';
import { ApiError } from '../api';

afterEach(() => {
  clearAccountPolicy();
  vi.unstubAllGlobals();
});
it('uses legacy defaults only when the account policy endpoint returns 404', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 404 })));
  expect(await loadAccountPolicy()).toEqual({ planId: 'default', policy: DEFAULT_APP_POLICY });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
  await expect(loadAccountPolicy()).rejects.toBeInstanceOf(ApiError);
});
it('clears policy at an account change without allowing late old-account cleanup to clear the new one', () => {
  const a = {
    planId: 'a',
    policy: { ...DEFAULT_APP_POLICY, uploads: { maxBytes: 5, maxFiles: 1 } },
  };
  setAccountPolicy('alice', a);
  expect(accountPolicy().value).toBe(a);
  clearAccountPolicy('alice');
  expect(accountPolicy().identity).toBeNull();
  const b = { planId: 'b', policy: DEFAULT_APP_POLICY };
  setAccountPolicy('bob', b);
  clearAccountPolicy('alice');
  expect(accountPolicy()).toEqual({ identity: 'bob', value: b });
});
it('enforces configurable upload counts and bytes and handles explicit unlimited limits', () => {
  expect(uploadPolicyError([{ size: 6 }], 0, { maxBytes: 5, maxFiles: 2 })).toEqual({
    message: 'Each file must be 5 bytes or smaller.',
    code: 'file_size',
  });
  expect(uploadPolicyError([{ size: 1 }], 1, { maxBytes: 5, maxFiles: 1 })?.code).toBe(
    'too_many_files',
  );
  expect(
    uploadPolicyError(
      Array.from({ length: 10 }, () => ({ size: 2_000_000 })),
      0,
      { maxBytes: null, maxFiles: null },
    ),
  ).toBeNull();
  expect(uploadPolicyError([{ size: 0 }], 0, { maxBytes: null, maxFiles: null })?.code).toBe(
    'file_size',
  );
});

it('rejects malformed successful policy responses instead of silently applying defaults', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ planId: 'bad', policy: {} })));
  await expect(loadAccountPolicy()).rejects.toThrow(
    'The server returned invalid account settings.',
  );
});
