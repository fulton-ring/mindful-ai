import { expect, it, vi } from 'vitest';
import type { ObjectStore } from '../../../storage/object-store';
import { openSqliteDatabase } from '../sqlite';
import { applySqliteMigrations } from '../sqlite-migrations';
import { createLocalEmbedder } from './embeddings';
import { createLocalSavedSources } from './saved-sources';

const directory = process.env.EMBEDDING_MODEL_DIR;
const revision = '751bff37182d3f1213fa05d7196b954e230abad9';
const dot = (a: number[], b: number[]) => a.reduce((sum, value, i) => sum + value * b[i]!, 0);

it.skipIf(!directory)(
  'runs pinned local 384d MiniLM without network and retrieves paraphrases outside lexical matches',
  async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Runtime networking forbidden in local embedding test');
    });
    const db = openSqliteDatabase(':memory:');
    try {
      await applySqliteMigrations(db, new URL('../../../../migrations/', import.meta.url));
      const embedder = createLocalEmbedder({ modelDirectory: directory!, revision });
      const signal = new AbortController().signal;
      const [query, related, unrelated] = await embedder.embed(
        [
          'A puppy is playing outdoors.',
          'The dog enjoys running through the park.',
          'Quarterly bond yields rose following the monetary policy meeting.',
        ],
        signal,
      );
      expect(query).toHaveLength(384);
      expect(dot(query!, related!)).toBeGreaterThan(dot(query!, unrelated!) + 0.15);
      const objects = new Map<string, string>();
      const blobs = {
        async put(key: string, value: string) {
          objects.set(key, value);
          return { key };
        },
        async get(key: string) {
          const text = objects.get(key);
          return text === undefined ? null : { text: async () => text };
        },
      } as unknown as ObjectStore;
      const sources = createLocalSavedSources({ db, blobs, embedder });
      await sources.upsert(
        {
          ownerScope: 'alice',
          url: 'https://example.com/animals',
          markdown: 'The dog enjoys running through the park.',
        },
        signal,
      );
      await sources.upsert(
        {
          ownerScope: 'alice',
          url: 'https://example.com/bonds',
          markdown: 'ZXQ9981: Quarterly bond yields rose following the monetary policy meeting.',
        },
        signal,
      );
      await sources.upsert(
        {
          ownerScope: 'bob',
          url: 'https://example.com/other-owner',
          markdown: 'A puppy is playing outdoors.',
        },
        signal,
      );
      expect(
        (await sources.search('alice', 'A puppy is playing outdoors.', signal)).results[0]?.url,
      ).toBe('https://example.com/animals');
      const lexical = await sources.search('alice', 'ZXQ9981', signal);
      expect(lexical.results[0]?.url).toBe('https://example.com/bonds');
      expect(
        (await sources.search('nobody', 'A puppy is playing outdoors.', signal)).results,
      ).toEqual([]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      db.close();
      fetcher.mockRestore();
    }
  },
  60_000,
);
