import type { PostHog } from 'posthog-js';

type Interaction =
  | 'page_viewed'
  | 'chat_submitted'
  | 'chat_completed'
  | 'chat_failed'
  | 'conversation_deleted'
  | 'note_opened'
  | 'note_closed'
  | 'note_capture_saved'
  | 'note_suggestion_accepted'
  | 'note_suggestion_rejected'
  | 'persona_selected'
  | 'theme_changed';
type Properties = {
  conversation_id?: string;
  turn_id?: string;
  persona_id?: string;
  action?: string;
  characters?: number;
  duration_ms?: number;
  route?: string;
  theme?: 'light' | 'dark';
};

let client: PostHog | undefined;
let identity: string | null = null;
let loading: Promise<void> | undefined;

function analyticsPath(path: string): string {
  return path.split(/[?#]/)[0].replace(/\/conversations\/[^/]+/, '/conversations/:id');
}

export function initializeTelemetry(config?: { key: string; host: string }): Promise<void> {
  if (loading) return loading;
  const key = config?.key || import.meta.env.VITE_POSTHOG_KEY;
  if (!key) return Promise.resolve();
  loading = import('posthog-js')
    .then(({ default: posthog }) => {
      posthog.init(key, {
        api_host: config?.host || import.meta.env.VITE_POSTHOG_HOST || 'https://us.i.posthog.com',
        autocapture: false,
        capture_pageview: false,
        capture_pageleave: false,
        disable_session_recording: true,
        disable_surveys: true,
        person_profiles: 'identified_only',
        before_send: (event) => {
          if (event) {
            const path = analyticsPath(location.pathname);
            event.properties.$current_url = `${location.origin}${path}`;
            event.properties.$pathname = path;
            for (const properties of [
              event.properties,
              event.properties.$set,
              event.properties.$set_once,
            ]) {
              if (!properties || typeof properties !== 'object') continue;
              for (const key of Object.keys(properties)) {
                if (key.includes('referrer') || key.startsWith('$initial_')) delete properties[key];
                else if (key.endsWith('pathname') && typeof properties[key] === 'string')
                  properties[key] = analyticsPath(properties[key]);
              }
            }
          }
          return event;
        },
      });
      client = posthog;
      if (identity) client.identify(identity);
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
  if (userId) client?.identify(userId);
}

export function track(event: Interaction, properties: Properties = {}) {
  if (!identity && event !== 'page_viewed') return;
  try {
    client?.capture(event === 'page_viewed' ? '$pageview' : event, {
      ...properties,
      ...(properties.route ? { route: analyticsPath(properties.route) } : {}),
    });
  } catch {
    /* Analytics is best effort. */
  }
}

/**
 * Stable id for one working session, so product events can be grouped. Kept in
 * sessionStorage alongside the drafts; a fresh tab starts a fresh session.
 */
export function productSessionId(): string {
  const key = 'walden:product-session';
  try {
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    const id = crypto.randomUUID();
    sessionStorage.setItem(key, id);
    return id;
  } catch {
    // Private windows and blocked site data still get a usable id; it just
    // stops grouping across reloads, which is better than dropping the event.
    return crypto.randomUUID();
  }
}
