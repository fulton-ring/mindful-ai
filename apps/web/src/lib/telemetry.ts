import type { PostHog } from 'posthog-js';
import { storageKeys } from './storage-keys';

type Interaction =
  | 'page_viewed'
  | 'chat_submitted'
  | 'chat_completed'
  | 'chat_failed'
  | 'chat_regeneration_started'
  | 'chat_regeneration_completed'
  | 'chat_regeneration_failed'
  | 'file_upload_started'
  | 'file_upload_completed'
  | 'file_upload_failed'
  | 'file_upload_blocked'
  | 'file_attachment_removed'
  | 'chat_preference_changed'
  | 'chat_preference_failed'
  | 'chat_tools_opened'
  | 'settings_section_opened'
  | 'file_picker_opened'
  | 'action_blocked'
  | 'note_suggestion_failed'
  | 'note_suggestion_requested'
  | 'note_suggestion_generated'
  | 'note_capture_failed'
  | 'note_capture_started'
  | 'note_capture_completed'
  | 'account_action_failed'
  | 'account_action_started'
  | 'account_action_completed'
  | 'conversation_action_failed'
  | 'note_deleted'
  | 'note_saved'
  | 'note_save_failed'
  | 'note_history_used'
  | 'note_history_failed'
  | 'conversation_archived'
  | 'conversation_deleted'
  | 'note_opened'
  | 'note_closed'
  | 'note_suggestion_accepted'
  | 'note_suggestion_rejected'
  | 'persona_selected'
  | 'theme_changed';
type Properties = {
  conversation_id?: string;
  request_id?: string;
  persona_id?: string;
  action?: string;
  characters?: number;
  duration_ms?: number;
  route?: string;
  theme?: 'light' | 'dark';
  failure_code?: string;
  http_status?: number;
  stage?: string;
  setting?: string;
  enabled?: boolean;
  file_type?: string;
  size_bucket?: string;
  attachment_count?: number;
  had_partial_response?: boolean;
  had_note?: boolean;
  tool_count?: number;
  source_count?: number;
  proposal_count?: number;
};

/** Bounded diagnostics only. Never send exception messages or user content. */
function httpFailureCode(status: number): string {
  const codes: Record<number, string> = {
    400: 'invalid_request',
    401: 'unauthorized',
    403: 'forbidden',
    404: 'not_found',
    409: 'conflict',
    413: 'too_large',
    415: 'unsupported_file',
    422: 'invalid_request',
    429: 'rate_limited',
  };
  return codes[status] ?? (status >= 500 ? 'service_error' : 'http_error');
}

export function failureDetails(error: unknown): Pick<Properties, 'failure_code' | 'http_status'> {
  if (error instanceof DOMException && error.name === 'AbortError')
    return { failure_code: 'cancelled' };
  const status =
    error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
      ? error.status
      : undefined;
  if (status !== undefined) return { failure_code: httpFailureCode(status), http_status: status };
  return { failure_code: 'network_or_client_error' };
}

export function fileAnalytics(file: File): Pick<Properties, 'file_type' | 'size_bucket'> {
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  const file_type =
    extension &&
    ['pdf', 'docx', 'xlsx', 'md', 'txt', 'csv', 'json', 'png', 'jpg', 'jpeg', 'webp'].includes(
      extension,
    )
      ? extension
      : file.type.startsWith('image/')
        ? 'image_other'
        : 'other';
  return {
    file_type,
    size_bucket:
      file.size > 1_000_000
        ? 'over_1mb'
        : file.size <= 100_000
          ? '0-100kb'
          : file.size <= 500_000
            ? '100-500kb'
            : '500kb-1mb',
  };
}

let client: PostHog | undefined;
let identity: string | null = null;
let loading: Promise<void> | undefined;

export function browserAnalyticsEnabled(): boolean {
  try {
    return localStorage.getItem(storageKeys.browserAnalytics) !== 'false';
  } catch {
    return true;
  }
}
export function setBrowserAnalyticsEnabled(enabled: boolean) {
  localStorage.setItem(storageKeys.browserAnalytics, String(enabled));
  if (enabled) client?.opt_in_capturing();
  else client?.opt_out_capturing();
}

function analyticsPath(path: string): string {
  return path
    .split(/[?#]/)[0]
    .replace(/\/(?:conversations|notes)\/[^/]+/, (segment) =>
      segment.startsWith('/notes/') ? '/notes/:id' : '/conversations/:id',
    );
}

type AnalyticsProperties = Record<string, unknown>;

function sanitizeAnalyticsProperties(properties: unknown) {
  if (!properties || typeof properties !== 'object') return;
  const record = properties as AnalyticsProperties;
  for (const key of Object.keys(record)) {
    if (key.includes('referrer') || key.startsWith('$initial_')) {
      delete record[key];
      continue;
    }
    if (key.endsWith('pathname') && typeof record[key] === 'string') {
      record[key] = analyticsPath(record[key]);
    }
  }
}

function prepareAnalyticsEvent(event: { properties: AnalyticsProperties }) {
  const path = analyticsPath(location.pathname);
  event.properties.$current_url = `${location.origin}${path}`;
  event.properties.$pathname = path;
  sanitizeAnalyticsProperties(event.properties);
  sanitizeAnalyticsProperties(event.properties.$set);
  sanitizeAnalyticsProperties(event.properties.$set_once);
}

export function initializeTelemetry(config?: { key: string; host: string }): Promise<void> {
  if (loading) return loading;
  const key = config?.key || import.meta.env.VITE_POSTHOG_KEY;
  if (!key) return Promise.resolve();
  loading = import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: config?.host || import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
        opt_out_capturing_by_default: !browserAnalyticsEnabled(),
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        disable_surveys: true,
        person_profiles: 'identified_only',
        before_send: (event) => {
          if (!browserAnalyticsEnabled()) return null;
          if (event) prepareAnalyticsEvent(event);
          return event;
        },
      });
      client = posthog;
      if (identity && browserAnalyticsEnabled()) client.identify(identity);
    })
    .catch(() => {
      // Optional analytics must never prevent sign-in, chat, or note saves.
    });
  return loading;
}

export function identifyTelemetry(userId: string | null) {
  if (identity === userId) return;
  if (identity) client?.reset();
  identity = userId;
  if (userId && browserAnalyticsEnabled()) client?.identify(userId);
}

export function track(event: Interaction, properties: Properties = {}) {
  if (!browserAnalyticsEnabled() || (!identity && event !== 'page_viewed')) return;
  try {
    client?.capture(event === 'page_viewed' ? '$pageview' : event, {
      ...properties,
      ...(properties.route ? { route: analyticsPath(properties.route) } : {}),
    });
  } catch {
    /* Analytics is best effort. */
  }
}
