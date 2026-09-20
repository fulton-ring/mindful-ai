// @vitest-environment jsdom

import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { ContextCheckpoint } from './ContextCheckpoint';

it('renders a non-interactive context compaction marker', () => {
  const view = render(<ContextCheckpoint />);
  expect(view.getByLabelText('Context compacted')).toBeTruthy();
  expect(view.queryByRole('button')).toBeNull();
  expect(view.queryByText(/restore/i)).toBeNull();
});
