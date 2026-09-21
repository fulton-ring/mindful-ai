// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ResponseActivity } from './ResponseActivity';

afterEach(cleanup);

it('renders sanitized tool status and summary without arguments or results', () => {
  const view = render(
    <ResponseActivity
      tools={[
        {
          id: 'call-1',
          name: 'readWebPage',
          state: 'complete',
          summary: 'Read one public page.',
        },
      ]}
    />,
  );

  const trigger = view.getByRole('button', { name: 'Activity' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(view.queryByText('Read one public page.')).toBeNull();
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(view.getByText('Completed')).toBeTruthy();
  expect(view.getByText('Read one public page.')).toBeTruthy();
  expect(view.queryByText(/https:\/\//)).toBeNull();
});

it('deduplicates safe sources, labels domains, and rejects unsafe links', () => {
  const view = render(
    <ResponseActivity
      sources={[
        { id: '1', url: 'https://www.example.com/report' },
        { id: '2', url: 'https://www.example.com/report', title: 'Duplicate' },
        { id: '3', url: 'javascript:alert(1)', title: 'Unsafe' },
        { id: '4', url: 'https://user:secret@example.net/private', title: 'Credentials' },
      ]}
    />,
  );

  const trigger = view.getByRole('button', { name: 'Activity' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(trigger);
  const link = view.getByRole('link', { name: /example.com/i });
  expect(link.getAttribute('href')).toBe('https://www.example.com/report');
  expect(link.getAttribute('target')).toBe('_blank');
  expect(view.queryByText('Unsafe')).toBeNull();
  expect(view.queryByText('Credentials')).toBeNull();
});

it('does not render sources in the activity disclosure', () => {
  const view = render(
    <ResponseActivity
      tools={[{ id: 'call-1', name: 'readWebPage', state: 'complete', summary: 'Read one page.' }]}
    />,
  );

  expect(view.getByRole('button', { name: 'Activity' })).toBeTruthy();
  expect(view.queryByRole('button', { name: '1 source' })).toBeNull();
});

it('announces running and failed tool states accessibly', () => {
  const view = render(
    <ResponseActivity
      tools={[
        { id: 'running', name: 'Searching sources', state: 'running', summary: 'In progress.' },
        {
          id: 'failed',
          name: 'Reading page',
          state: 'error',
          summary: 'The page could not be read.',
        },
      ]}
    />,
  );

  fireEvent.click(view.getByRole('button', { name: 'Activity' }));
  expect(view.getByText('Running')).toBeTruthy();
  expect(view.getByText('Failed')).toBeTruthy();
});

it('shows each query with its results, including no-result searches', () => {
  const view = render(
    <ResponseActivity
      tools={[
        {
          id: 'one',
          name: 'searchWeb',
          state: 'complete',
          summary: '',
          query: 'recent platform incident',
          sources: [{ id: 's', url: 'https://example.org/report', title: 'Incident report' }],
        },
        {
          id: 'two',
          name: 'searchWeb',
          state: 'complete',
          summary: '',
          query: 'follow up query',
          sources: [],
        },
      ]}
    />,
  );
  fireEvent.click(view.getByRole('button', { name: 'Activity' }));
  expect(view.getByText('“recent platform incident”')).toBeTruthy();
  expect(view.getByRole('link', { name: 'Incident report' }).getAttribute('href')).toBe(
    'https://example.org/report',
  );
  expect(view.getByText('“follow up query”')).toBeTruthy();
  expect(view.getByText('No sources returned.')).toBeTruthy();
});
it('keeps legacy sources available inside activity without inventing a query', () => {
  const view = render(
    <ResponseActivity
      sources={[{ id: 'old', url: 'https://example.org/report', title: 'Old report' }]}
    />,
  );
  fireEvent.click(view.getByRole('button', { name: 'Activity' }));
  expect(view.getByText('Retrieved sources')).toBeTruthy();
  expect(view.getByRole('link', { name: 'Old report' })).toBeTruthy();
});

it('hides tools that only control how a response is presented', () => {
  const view = render(
    <ResponseActivity
      tools={[
        {
          id: 'quiz',
          name: 'proposeLearningCheck',
          state: 'complete',
          summary: 'Prepared a learning check.',
        },
        {
          id: 'question',
          name: 'proposeAsk',
          state: 'complete',
          summary: 'Prepared a clarification.',
        },
      ]}
    />,
  );

  expect(view.queryByRole('button', { name: 'Activity' })).toBeNull();
});
