import { afterEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: sdk }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

it('strips query strings and private thread or note identifiers from automatic SDK URL properties', async () => {
  vi.stubGlobal('location', {
    origin: 'https://walden.test',
    pathname: '/conversations/private-id',
    search: '?secret=private',
  });
  const telemetry = await import('../telemetry');
  await telemetry.initializeTelemetry({ key: 'phc_runtime', host: 'https://us.i.posthog.com' });
  const sanitize = sdk.init.mock.calls[0]?.[1].before_send;
  const event = sanitize({
    properties: {
      $current_url: 'private',
      $prev_pageview_pathname: '/conversations/private-id',
      $referrer: 'private',
      $set_once: { $initial_current_url: 'private' },
    },
  });
  expect(event.properties.$current_url).toBe('https://walden.test/conversations/:id');
  expect(JSON.stringify(event)).not.toContain('private');

  const malformed = sanitize({
    properties: {
      $set: null,
      $set_once: 'not-an-object',
    },
  });
  expect(malformed.properties.$set).toBeNull();
  expect(malformed.properties.$set_once).toBe('not-an-object');

  vi.stubGlobal('location', {
    origin: 'https://walden.test',
    pathname: '/notes/private-note',
    search: '',
  });
  const noteEvent = sanitize({ properties: { $current_url: 'private' } });
  expect(noteEvent.properties.$current_url).toBe('https://walden.test/notes/:id');
  expect(JSON.stringify(noteEvent)).not.toContain('private');
});

it('captures standard anonymous pageviews with normalized paths from runtime configuration', async () => {
  const telemetry = await import('../telemetry');
  await telemetry.initializeTelemetry({ key: 'phc_runtime', host: 'https://us.i.posthog.com' });
  telemetry.track('page_viewed', { route: '/conversations/private-thread?branch=private' });
  expect(sdk.capture).toHaveBeenCalledWith('$pageview', { route: '/conversations/:id' });
  telemetry.track('chat_submitted');
  expect(sdk.capture).toHaveBeenCalledTimes(1);
});

it('does not initialize or send events without a project key', async () => {
  vi.stubEnv('VITE_POSTHOG_KEY', '');
  const telemetry = await import('../telemetry');
  await telemetry.initializeTelemetry();
  telemetry.identifyTelemetry('user-test');
  telemetry.track('chat_submitted', { characters: 50 });
  expect(sdk.init).not.toHaveBeenCalled();
  expect(sdk.capture).not.toHaveBeenCalled();
});

it('uses explicit metrics, disables content collection, and resets identity on logout', async () => {
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
  const telemetry = await import('../telemetry');
  telemetry.identifyTelemetry('user-test');
  await telemetry.initializeTelemetry();
  expect(sdk.init).toHaveBeenCalledWith(
    'phc_test',
    expect.objectContaining({
      autocapture: false,
      capture_pageview: false,
      disable_session_recording: true,
      api_host: 'https://us.i.posthog.com',
    }),
  );
  expect(sdk.identify).toHaveBeenCalledWith('user-test');
  telemetry.track('chat_completed', { conversation_id: 'c', duration_ms: 150 });
  expect(sdk.capture).toHaveBeenCalledWith('chat_completed', {
    conversation_id: 'c',
    duration_ms: 150,
  });
  telemetry.identifyTelemetry(null);
  telemetry.track('chat_submitted');
  expect(sdk.reset).toHaveBeenCalledTimes(1);
  expect(sdk.capture).toHaveBeenCalledTimes(1);
});

it('does not capture or identify when browser analytics is disabled', async () => {
  vi.stubGlobal('localStorage', { getItem: () => 'false' });
  const telemetry = await import('../telemetry');
  await telemetry.initializeTelemetry({ key: 'phc_test', host: 'https://us.i.posthog.com' });
  telemetry.identifyTelemetry('user-private');
  telemetry.track('page_viewed');
  telemetry.track('chat_submitted');
  expect(sdk.identify).not.toHaveBeenCalled();
  expect(sdk.capture).not.toHaveBeenCalled();
  expect(sdk.init.mock.calls[0]?.[1].before_send({ properties: {} })).toBeNull();
});
