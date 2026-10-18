import { expect, it } from 'vitest';
import { requireSameOrigin } from '../auth';

it('uses the configured public origin behind a TLS terminating proxy', () => {
  const request = new Request('http://backend:3000/api/notes', {
    method: 'POST',
    headers: { origin: 'https://walden.example' },
  });
  expect(() => requireSameOrigin(request, 'https://walden.example')).not.toThrow();
});
it('rejects other origins and ignores untrusted forwarded headers', () => {
  const request = new Request('http://backend:3000/api/notes', {
    method: 'POST',
    headers: {
      origin: 'https://evil.example',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
    },
  });
  expect(() => requireSameOrigin(request, 'https://walden.example')).toThrow(/Cross-origin/);
});
it('retains direct request origin checks and rejects malformed deployment origins', () => {
  const request = new Request('http://localhost:3000/api/notes', {
    method: 'POST',
    headers: { origin: 'http://localhost:3000' },
  });
  expect(() => requireSameOrigin(request)).not.toThrow();
  expect(() => requireSameOrigin(request, 'invalid')).toThrow();
});
