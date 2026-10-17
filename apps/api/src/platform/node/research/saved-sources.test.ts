import { expect, it } from 'vitest';
import type { ObjectStore } from '../../../storage/object-store';
import { openSqliteDatabase } from '../sqlite';
import { applySqliteMigrations } from '../sqlite-migrations';
import type { ResearchEmbedder } from './embeddings';
import { createLocalSavedSources } from './saved-sources';

const signal = new AbortController().signal;
async function fixture() {
  const db = openSqliteDatabase(':memory:');
  await applySqliteMigrations(db, new URL('../../../../migrations/', import.meta.url));
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
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...objects.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
        truncated: false,
      };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
  } as unknown as ObjectStore;
  let failing = false;
  const embedder: ResearchEmbedder = {
    revision: 'fixture-minilm-384',
    async embed(texts) {
      if (failing) throw new Error('simulated inference failure');
      return texts.map((text) => {
        const vector = Array(384).fill(0) as number[];
        // Fixture embeddings stand in for MiniLM while real inference is tested separately.
        vector[/puppy|canine|dog/i.test(text) ? 0 : 1] = 1;
        return vector;
      });
    },
  };
  return {
    db,
    blobs,
    embedder,
    objects,
    fail: (value: boolean) => {
      failing = value;
    },
    index: () => createLocalSavedSources({ db, blobs, embedder }),
  };
}
it('fuses lexical and semantic retrieval across the entire owner corpus and preserves provenance', async () => {
  const f = await fixture();
  try {
    const index = f.index();
    await index.upsert(
      {
        ownerScope: 'alice',
        url: 'https://example.com/canine',
        markdown: 'A canine enjoys playing in the park.',
      },
      signal,
    );
    await index.upsert(
      {
        ownerScope: 'alice',
        url: 'https://example.com/lexical',
        markdown: 'ZXQ9981 is a product reference.',
      },
      signal,
    );
    await index.upsert(
      {
        ownerScope: 'bob',
        url: 'https://example.com/private',
        markdown: 'A puppy secret belonging to Bob.',
      },
      signal,
    );
    const semantic = await index.search('alice', 'puppy', signal);
    expect(semantic.results[0]).toMatchObject({
      url: 'https://example.com/canine',
      text: expect.stringContaining('canine'),
    });
    expect(semantic.results.some((result) => result.url.includes('private'))).toBe(false);
    expect((await index.search('alice', 'ZXQ9981', signal)).results[0]?.url).toBe(
      'https://example.com/lexical',
    );
    expect((await index.search('nobody', 'puppy', signal)).results).toEqual([]);
    expect(f.objects.size).toBe(3);
  } finally {
    f.db.close();
  }
});
it('atomically replaces chunks and resumes persisted failed indexing after restart', async () => {
  const f = await fixture();
  try {
    const source = {
      ownerScope: 'alice',
      url: 'https://example.com/page',
      markdown: 'Original canine facts.',
    };
    await f.index().upsert(source, signal);
    f.fail(true);
    expect(
      await f.index().upsert({ ...source, markdown: 'Replacement puppy facts.' }, signal),
    ).toMatchObject({ status: 'failed' });
    expect(
      (
        await f
          .index()
          .search('alice', 'puppy', signal)
          .catch(() => ({ results: [] }))
      ).results,
    ).toEqual([]);
    expect(await f.db.prepare('SELECT text FROM research_chunks').first('text')).toBe(
      'Original canine facts.',
    );
    f.fail(false);
    const restarted = f.index();
    await restarted.resume();
    expect(await f.db.prepare('SELECT text FROM research_chunks').first('text')).toBe(
      'Replacement puppy facts.',
    );
    expect(await f.db.prepare('SELECT status FROM research_indexing_jobs').first('status')).toBe(
      'complete',
    );
    await restarted.upsert({ ...source, markdown: 'Replacement puppy facts.' }, signal);
    expect(await f.db.prepare('SELECT count(*) AS total FROM research_chunks').first('total')).toBe(
      1,
    );
    await restarted.deleteOwner('alice');
    expect(
      await f.db.prepare('SELECT count(*) AS total FROM research_sources').first('total'),
    ).toBe(0);
    expect(
      await f.db.prepare('SELECT count(*) AS total FROM research_chunks_fts').first('total'),
    ).toBe(0);
    expect(f.objects.size).toBe(0);
  } finally {
    f.db.close();
  }
});
it('keeps the old source and FTS rows when an atomic replacement fails', async () => {
  const f = await fixture();
  try {
    const index = f.index();
    const source = {
      ownerScope: 'alice',
      url: 'https://example.com/page',
      markdown: 'Original canine facts.',
    };
    await index.upsert(source, signal);
    await f.db.exec(
      "CREATE TRIGGER fail_chunk BEFORE INSERT ON research_chunks WHEN NEW.text LIKE 'Replacement%' BEGIN SELECT RAISE(ABORT,'injected failure'); END",
    );
    expect(
      await index.upsert({ ...source, markdown: 'Replacement puppy facts.' }, signal),
    ).toMatchObject({ status: 'failed' });
    expect(await f.db.prepare('SELECT text FROM research_chunks').first('text')).toBe(
      'Original canine facts.',
    );
    expect(await f.db.prepare('SELECT text FROM research_chunks_fts').first('text')).toBe(
      'Original canine facts.',
    );
    await f.db.exec('DROP TRIGGER fail_chunk');
    await f.index().resume();
    expect(await f.db.prepare('SELECT text FROM research_chunks').first('text')).toBe(
      'Replacement puppy facts.',
    );
  } finally {
    f.db.close();
  }
});

it('rebuilds completed sources from persisted Markdown when the pinned model revision changes', async () => {
  const f = await fixture();
  try {
    await f
      .index()
      .upsert(
        { ownerScope: 'alice', url: 'https://example.com/page', markdown: 'A canine plays.' },
        signal,
      );
    const revised = createLocalSavedSources({
      db: f.db,
      blobs: f.blobs,
      embedder: { ...f.embedder, revision: 'new-minilm-revision' },
    });
    await revised.resume();
    expect(
      await f.db.prepare('SELECT model_revision FROM research_sources').first('model_revision'),
    ).toBe('new-minilm-revision');
    expect(
      await f.db.prepare('SELECT model_revision FROM research_chunks').first('model_revision'),
    ).toBe('new-minilm-revision');
    expect((await revised.search('alice', 'puppy', signal)).results[0]?.url).toBe(
      'https://example.com/page',
    );
  } finally {
    f.db.close();
  }
});

it('cancels a stale failed replacement when the original page is retrieved again', async () => {
  const f = await fixture();
  try {
    const source = {
      ownerScope: 'alice',
      url: 'https://example.com/page',
      markdown: 'Original canine facts.',
    };
    await f.index().upsert(source, signal);
    f.fail(true);
    await f.index().upsert({ ...source, markdown: 'Replacement puppy facts.' }, signal);
    f.fail(false);
    expect(await f.index().upsert(source, signal)).toMatchObject({ status: 'complete' });
    await f.index().resume();
    expect(await f.db.prepare('SELECT text FROM research_chunks').first('text')).toBe(
      source.markdown,
    );
  } finally {
    f.db.close();
  }
});

it('prevents an in-flight page read in another process from recreating a deleted owner index', async () => {
  const f = await fixture();
  try {
    const original = f.index();
    await f.index().deleteOwner('alice');
    await expect(
      original.upsert(
        {
          ownerScope: 'alice',
          url: 'https://example.com/late',
          markdown: 'A late retrieved public page.',
        },
        signal,
      ),
    ).rejects.toThrow('deleted');
    expect(
      await f.db.prepare('SELECT count(*) AS total FROM research_indexing_jobs').first('total'),
    ).toBe(0);
    expect(f.objects.size).toBe(0);
  } finally {
    f.db.close();
  }
});

it('removes a blob whose pending write completes after owner deletion', async () => {
  const f = await fixture();
  try {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve)),
      started = new Promise<void>((resolve) => (entered = resolve));
    const put = f.blobs.put.bind(f.blobs);
    const racingBlobs = {
      ...f.blobs,
      put: async (...args: Parameters<ObjectStore['put']>) => {
        entered();
        await blocked;
        return put(...args);
      },
    };
    const reader = createLocalSavedSources({ db: f.db, blobs: racingBlobs, embedder: f.embedder });
    const pending = reader.upsert(
      {
        ownerScope: 'alice',
        url: 'https://example.com/late',
        markdown: 'A late retrieved public page.',
      },
      signal,
    );
    await started;
    await f.index().deleteOwner('alice');
    release();
    await expect(pending).rejects.toThrow('deleted');
    expect(f.objects.size).toBe(0);
    expect(
      await f.db.prepare('SELECT count(*) AS total FROM research_indexing_jobs').first('total'),
    ).toBe(0);
  } finally {
    f.db.close();
  }
});
