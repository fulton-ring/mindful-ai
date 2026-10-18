import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { researchOwnerScope, resolveSavedSources } from '../research';

const configured =
  process.env.RUN_LIVE_AI_SEARCH === '1' &&
  process.env.CLOUDFLARE_ACCOUNT_ID &&
  process.env.CLOUDFLARE_API_TOKEN &&
  process.env.AI_SEARCH_INSTANCE;

it.skipIf(!configured)(
  'uploads, indexes, searches and deletes owner-scoped sources in the disposable Cloudflare index',
  async () => {
    expect(process.env.AI_SEARCH_INSTANCE).toBe('walden-e2e');
    const run = randomUUID();
    const scope = await researchOwnerScope(`walden-e2e:${run}`);
    const otherScope = await researchOwnerScope(`walden-e2e:other:${run}`);
    const signal = AbortSignal.timeout(210_000);
    const sources = resolveSavedSources(process.env, signal)!;
    const url = `https://example.com/walden-e2e/${run}`;
    const marker = `Walden observatory verification ${run}`;
    try {
      const item = await sources.upsert(
        {
          ownerScope: scope,
          url,
          markdown: `# ${marker}\n\nThe fictional sapphire observatory opens at noon.`,
        },
        signal,
      );
      expect(item.status, item.reason).not.toBe('failed');
      expect(item.id).toBeTruthy();
      console.info('Cloudflare fixture uploaded', { status: item.status });
      await expect
        .poll(async () => (await sources.search(scope, marker, signal)).results, {
          timeout: 180_000,
          interval: 5_000,
        })
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ url, text: expect.stringContaining('sapphire observatory') }),
          ]),
        );
      console.info('Cloudflare indexed retrieval passed');
      expect((await sources.search(otherScope, marker, signal)).results).toEqual([]);
      console.info('Cloudflare owner isolation passed');
    } catch (error) {
      console.info('Cloudflare source verification failed', {
        status: (error as Error & { status?: number }).status,
        message: (error as Error).message,
      });
      throw error;
    } finally {
      // The unique scope owns only this run's fixture; never delete the shared instance.
      const cleanup = resolveSavedSources(process.env, AbortSignal.timeout(30_000))!;
      await cleanup.deleteOwner(scope);
    }
    // Managed index deletion becomes visible to retrieval asynchronously.
    await expect
      .poll(async () => (await sources.search(scope, marker, signal)).results, {
        timeout: 30_000,
        interval: 2_000,
      })
      .toEqual([]);
  },
  240_000,
);
