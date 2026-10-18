// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { DEFAULT_APP_POLICY } from '@walden/contracts';
import { afterEach, expect, it, vi } from 'vitest';
import { clearAccountPolicy, setAccountPolicy } from '../../../../lib/account-policy';
import { ChatComposer } from '../ui/ChatComposer';

afterEach(() => {
  cleanup();
  clearAccountPolicy();
});
const props = () => ({
  input: '',
  sending: false,
  savingChatPreference: false,
  webSearch: true,
  learningChecks: true,
  autoHighlights: true,
  personas: [],
  personaId: 'thinking-partner',
  messageInput: { current: null },
  onInput: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  onPersona: vi.fn(),
  onPreference: vi.fn(),
  onAutoHighlights: vi.fn(),
  onAttach: vi.fn(),
});
it('uses account upload limits instead of hardcoded defaults', () => {
  setAccountPolicy('owner', {
    planId: 'small',
    policy: { ...DEFAULT_APP_POLICY, uploads: { maxFiles: 1, maxBytes: 10 } },
  });
  const values = props();
  const view = render(<ChatComposer {...values} />);
  fireEvent.change(view.getByLabelText('Choose files'), {
    target: { files: [new File(['a'], 'a.txt'), new File(['b'], 'b.txt')] },
  });
  expect(view.getByRole('alert').textContent).toBe('Choose up to 1 file.');
  expect(values.onAttach).not.toHaveBeenCalled();
});
it('accepts more than five files and larger files when the account has unlimited uploads', () => {
  setAccountPolicy('owner', {
    planId: 'unlimited',
    policy: { ...DEFAULT_APP_POLICY, uploads: { maxFiles: null, maxBytes: null } },
  });
  const values = props();
  const view = render(<ChatComposer {...values} />);
  const files = [
    new File([new Uint8Array(1_000_001)], 'large.txt'),
    ...Array.from({ length: 5 }, (_, i) => new File(['x'], `file${i}.txt`)),
  ];
  fireEvent.change(view.getByLabelText('Choose files'), { target: { files } });
  expect(values.onAttach).toHaveBeenCalledWith(files);
});
it('removes document types when account policy disables extraction', () => {
  setAccountPolicy('owner', {
    planId: 'plain',
    policy: {
      ...DEFAULT_APP_POLICY,
      features: { ...DEFAULT_APP_POLICY.features, documentExtraction: false },
    },
  });
  const view = render(<ChatComposer {...props()} />);
  expect(view.getByLabelText('Choose files').getAttribute('accept')).not.toContain('.pdf');
});
