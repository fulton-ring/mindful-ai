// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import type { WaldenUIMessage } from '@walden/contracts';
import { afterEach, expect, it } from 'vitest';
import { ResponseActivity, ResponseSources } from '../ResponseActivity';

afterEach(cleanup);

type Part = WaldenUIMessage['parts'][number];

/** A static `tool-<name>` part as the server streams it. */
function tool(
  id: string,
  name: string,
  state: 'input-available' | 'output-available' | 'output-error',
  extra: { input?: unknown; output?: unknown; errorText?: string } = {},
): Part {
  return {
    type: `tool-${name}`,
    toolCallId: id,
    state,
    input: extra.input ?? {},
    ...(state === 'output-available' ? { output: extra.output ?? {} } : {}),
    ...(state === 'output-error' ? { errorText: extra.errorText ?? 'Tool failed' } : {}),
  } as Part;
}

const source = (id: string, url: string, title?: string): Part => ({
  type: 'source-url',
  sourceId: id,
  url,
  ...(title ? { title } : {}),
});

it('renders sanitized tool status and summary without arguments or results', () => {
  const view = render(
    <ResponseActivity
      parts={[
        tool('call-1', 'readWebPage', 'output-available', {
          input: { secret: 'raw argument' },
          output: { summary: 'Read one public page.', body: 'https://raw.example/result' },
        }),
      ]}
    />,
  );

  const trigger = view.getByRole('button', { name: 'Activity' });
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(view.queryByText('Read one public page.')).toBeNull();
  fireEvent.click(trigger);
  expect(trigger.getAttribute('aria-expanded')).toBe('true');
  expect(view.getByText('Read page')).toBeTruthy();
  expect(view.getByText('Completed')).toBeTruthy();
  expect(view.getByText('Read one public page.')).toBeTruthy();
  expect(view.queryByText(/raw/)).toBeNull();
});

it('deduplicates safe sources, labels domains, and rejects unsafe links', () => {
  const view = render(
    <ResponseActivity
      parts={[
        source('1', 'https://www.example.com/report'),
        source('2', 'https://www.example.com/report', 'Duplicate'),
        source('3', 'javascript:alert(1)', 'Unsafe'),
        source('4', 'https://user:secret@example.net/private', 'Credentials'),
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

it('does not render the sources list in the activity disclosure', () => {
  const view = render(
    <ResponseActivity parts={[tool('call-1', 'readWebPage', 'output-available')]} />,
  );

  expect(view.getByRole('button', { name: 'Activity' })).toBeTruthy();
  expect(view.queryByRole('button', { name: '1 source' })).toBeNull();
});

it('announces running and failed tool states accessibly, with the failure summary', () => {
  const view = render(
    <ResponseActivity
      parts={[
        tool('running', 'searchSources', 'input-available', { input: { query: 'tides' } }),
        tool('failed', 'searchWeb', 'output-error', {
          input: { query: 'storms' },
          errorText: 'Web search failed',
        }),
      ]}
    />,
  );

  fireEvent.click(view.getByRole('button', { name: 'Activity' }));
  expect(view.getByText('Running')).toBeTruthy();
  expect(view.getByText('Failed')).toBeTruthy();
  expect(view.getByText('“storms”')).toBeTruthy();
  expect(view.getByText('Web search failed')).toBeTruthy();
});

it('shows a tool left running by an interrupted reply as stopped', () => {
  const view = render(
    <ResponseActivity
      interrupted
      parts={[tool('call', 'readWebPage', 'input-available', { input: { query: 'a' } })]}
    />,
  );
  fireEvent.click(view.getByRole('button', { name: 'Activity' }));
  expect(view.getByText('Failed')).toBeTruthy();
  expect(view.getByText('Stopped')).toBeTruthy();
});

it('shows each query with its results, including no-result searches', () => {
  const view = render(
    <ResponseActivity
      parts={[
        tool('one', 'searchWeb', 'output-available', {
          input: { query: 'recent platform incident' },
          output: { sources: [{ url: 'https://example.org/report', title: 'Incident report' }] },
        }),
        tool('two', 'searchWeb', 'output-available', {
          input: { query: 'follow up query' },
          output: { sources: [] },
        }),
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

it('keeps sources without a tool available inside activity without inventing a query', () => {
  const view = render(
    <ResponseActivity parts={[source('old', 'https://example.org/report', 'Old report')]} />,
  );
  fireEvent.click(view.getByRole('button', { name: 'Activity' }));
  expect(view.getByText('Retrieved sources')).toBeTruthy();
  expect(view.getByRole('link', { name: 'Old report' })).toBeTruthy();
});

it('hides tools that only control how a response is presented', () => {
  const view = render(
    <ResponseActivity
      parts={[
        tool('quiz', 'proposeLearningCheck', 'output-available'),
        tool('question', 'proposeAsk', 'output-available'),
      ]}
    />,
  );

  expect(view.queryByRole('button', { name: 'Activity' })).toBeNull();
});

it('lists a response’s source-url parts once each', () => {
  const view = render(
    <ResponseSources
      parts={[
        source('a', 'https://example.org/a', 'A'),
        source('b', 'https://example.org/a', 'A again'),
        { type: 'text', text: 'Body' },
      ]}
    />,
  );
  expect(view.getByRole('button', { name: '1 source' })).toBeTruthy();
});
