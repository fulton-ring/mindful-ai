import type { AppDatabase } from '../db/database';
/** Only new, user-visible exchanges are captured. Mastra's raw spans stay private. */
export const PRIVACY_VERSION = '2026-09-20';
type Env = {
  DB?: AppDatabase;
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  POSTHOG_PERSONAL_API_KEY?: string;
  POSTHOG_PROJECT_ID?: string;
};
export async function contentPreference(db: AppDatabase | undefined, ownerId: string | undefined) {
  if (!db || !ownerId) return null;
  try {
    return await db
      .prepare(
        `SELECT p.enabled,p.revision FROM account_privacy p JOIN users u ON u.id=p.owner_id WHERE p.owner_id=? AND p.disclosure_version=? AND u.deletion_pending=0`,
      )
      .bind(ownerId, PRIVACY_VERSION)
      .first<{ enabled: number; revision: string }>();
  } catch {
    // Missing migration or unavailable DB must never enable collection.
    return null;
  }
}
export function redactContent(text: string) {
  return text
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[redacted]',
    )
    .replace(
      /\b(?:Bearer\s+[\w.+/=-]+|(?:sk-|phx_|phc_|ghp_|gho_)[\w-]{10,}|eyJ[\w.-]{15,})/gi,
      '[redacted]',
    )
    .replace(
      /\b(password|secret|api[_-]?key|token|authorization|cookie)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]',
    )
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[redacted]')
    .slice(0, 24_000);
}
export async function captureConversation(
  env: Env,
  turn: {
    ownerId: string;
    userId: string;
    turnId: string;
    conversationId: string;
    message: string;
    response: string;
    startedAt: number;
    preferenceVersion: string;
    incomplete?: boolean;
  },
) {
  // Do not collect conversation content unless provider deletion is configured.
  if (!env.POSTHOG_API_KEY || !env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) return;
  const preference = await contentPreference(env.DB, turn.ownerId);
  if (!preference?.enabled || preference.revision !== turn.preferenceVersion) return;
  try {
    const response = await fetch(`${env.POSTHOG_HOST || 'https://us.i.posthog.com'}/i/v0/e/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(1500),
      body: JSON.stringify({
        api_key: env.POSTHOG_API_KEY,
        event: '$ai_trace',
        properties: {
          distinct_id: turn.userId,
          $geoip_disable: true,
          $process_person_profile: false,
          $ai_trace_id: turn.turnId,
          $ai_span_id: turn.turnId,
          $ai_session_id: turn.conversationId,
          $ai_span_name: 'Visible conversation',
          $ai_input_state: { message: redactContent(turn.message) },
          $ai_output_state: { response: redactContent(turn.response) },
          $ai_latency: (Date.now() - turn.startedAt) / 1000,
          $ai_is_error: !!turn.incomplete,
          disclosure_version: PRIVACY_VERSION,
          telemetry_scope: 'visible_exchange',
        },
      }),
    });
    if (!response.ok) console.warn('Conversation telemetry delivery failed');
    await response.body?.cancel();
  } catch {
    console.warn('Conversation telemetry delivery failed');
  }
}
/** Uses the existing scheduled Worker; failed requests remain available for retry. */
export async function purgeTelemetry(env: Env) {
  if (!env.DB || !env.POSTHOG_PERSONAL_API_KEY || !env.POSTHOG_PROJECT_ID) return;
  const pending = await env.DB.prepare(
    'SELECT distinct_id FROM telemetry_deletions WHERE requested_at<? LIMIT 100',
  )
    .bind(new Date(Date.now() - 10 * 60_000).toISOString())
    .all<{ distinct_id: string }>();
  for (const row of pending.results) {
    try {
      const host = (env.POSTHOG_HOST || 'https://us.i.posthog.com').includes('eu.')
        ? 'https://eu.posthog.com'
        : 'https://us.posthog.com';
      const response = await fetch(
        `${host}/api/projects/${encodeURIComponent(env.POSTHOG_PROJECT_ID)}/persons/bulk_delete/`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`,
            'content-type': 'application/json',
          },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            distinct_ids: [row.distinct_id],
            delete_events: true,
            delete_recordings: true,
          }),
        },
      );
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const result = (await response.json()) as {
        events_queued_for_deletion?: boolean;
        deletion_errors?: unknown[];
      };
      if (result.events_queued_for_deletion && !result.deletion_errors?.length)
        await env.DB.prepare('DELETE FROM telemetry_deletions WHERE distinct_id=?')
          .bind(row.distinct_id)
          .run();
    } catch {
      console.warn('Telemetry deletion pending retry');
    }
  }
}
