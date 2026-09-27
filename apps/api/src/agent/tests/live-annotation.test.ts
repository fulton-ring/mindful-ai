import { describe, expect, it } from 'vitest';
import { createCloudflareModel, DEFAULT_AI_MODEL } from '../../services/agent/agent';
import { annotateResponse } from '../stream-events';

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

describe.skipIf(!token || !accountId)('Cloudflare Markdown annotations', () => {
  it('preserves raw formatting so the selected passage survives exact-match validation', async () => {
    const source = '**Ice** is less dense than liquid water. Water expands when it freezes.';
    const annotations = await annotateResponse({
      text: source,
      turnId: 'synthetic-markdown',
      model: createCloudflareModel(
        { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: token },
        DEFAULT_AI_MODEL,
      ),
      signal: AbortSignal.timeout(25_000),
      conversationId: 'synthetic-markdown',
    });
    expect(annotations.some((item) => item.quote.includes('**Ice**'))).toBe(true);
    for (const item of annotations) expect(source).toContain(item.quote);
  }, 30_000);
});
