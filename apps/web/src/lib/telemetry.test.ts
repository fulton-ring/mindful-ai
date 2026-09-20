import { afterEach, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
}));
vi.mock('posthog-js', () => ({ default: sdk }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

it('does not initialize or send events without a project key', async () => {
  vi.stubEnv('VITE_POSTHOG_KEY', '');
  const telemetry = await import('./telemetry');
  await telemetry.initializeTelemetry();
  telemetry.identifyTelemetry('user-test');
  telemetry.track('chat_submitted', { characters: 50 });
  expect(sdk.init).not.toHaveBeenCalled();
  expect(sdk.capture).not.toHaveBeenCalled();
});

it('uses explicit metrics, disables content collection, and resets identity on logout', async () => {
  vi.stubEnv('VITE_POSTHOG_KEY', 'phc_test');
  const telemetry = await import('./telemetry');
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
