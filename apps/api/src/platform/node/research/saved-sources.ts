import { createHash } from 'node:crypto';
import type { AppDatabase, AppStatement } from '../../../db/database';
import type { SavedSources } from '../../../services/research/ports';
import { publicUrl } from '../../../services/research/research-common';
import type { ObjectStore } from '../../../storage/object-store';
import type { ResearchEmbedder } from './embeddings';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
type Job = {
  id: string;
  owner_scope: string;
  source_url: string;
  blob_key: string;
  content_hash: string;
};
type Chunk = {
  id: string;
  text: string;
  embedding: string;
  source_url: string;
  model_revision: string;
};

export function chunkMarkdown(markdown: string): string[] {
  const chunks: string[] = [];
  // Bounded overlapping passages keep paragraph context without oversized excerpts.
  for (let start = 0; start < markdown.length; start += 1600)
    chunks.push(markdown.slice(start, start + 2000));
  return chunks.filter((chunk) => chunk.trim());
}
function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length) return 0;
  let dot = 0,
    a = 0,
    b = 0;
  for (let i = 0; i < left.length; i++) {
    dot += left[i]! * right[i]!;
    a += left[i]! ** 2;
    b += right[i]! ** 2;
  }
  return a && b ? dot / Math.sqrt(a * b) : 0;
}

class LocalSavedSources implements SavedSources {
  constructor(
    readonly db: AppDatabase,
    readonly blobs: ObjectStore,
    readonly embedder: ResearchEmbedder,
  ) {}
  // ponytail: one in-process queue; database compare-and-swap also protects concurrent processes.
  private tail: Promise<unknown> = Promise.resolve();
  private serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = this.tail.then(operation);
    this.tail = next.catch(() => {});
    return next;
  };
  private sql = (query: string, ...values: unknown[]) => this.db.prepare(query).bind(...values);
  private async admitJob(job: Job, status: 'complete' | 'pending') {
    await this.sql(
      "INSERT INTO app_settings(key,value) VALUES(?,'active') ON CONFLICT(key) DO NOTHING",
      `research_owner:${job.owner_scope}`,
    ).run();
    const admitted = await this.sql(
      `INSERT INTO research_indexing_jobs(id,owner_scope,source_url,blob_key,content_hash,status,attempts,error,updated_at) SELECT ?,?,?,?,?,?,0,NULL,? FROM app_settings WHERE key=? AND value='active'${this.db.dialect === 'postgres' ? ' FOR UPDATE' : ''} ON CONFLICT(id) DO UPDATE SET blob_key=excluded.blob_key,content_hash=excluded.content_hash,status=excluded.status,error=NULL,updated_at=excluded.updated_at`,
      job.id,
      job.owner_scope,
      job.source_url,
      job.blob_key,
      job.content_hash,
      status,
      new Date().toISOString(),
      `research_owner:${job.owner_scope}`,
    ).run();
    if (!admitted.meta.changes) {
      await this.blobs.delete(job.blob_key);
      throw new Error('Research owner index was deleted.');
    }
  }
  private replacementStatements(
    job: Job,
    chunks: string[],
    embeddings: number[][],
  ): AppStatement[] {
    const statements: AppStatement[] = [];
    if (this.db.dialect === 'postgres')
      statements.push(
        this.sql(
          'SELECT key FROM app_settings WHERE key=? FOR UPDATE',
          `research_owner:${job.owner_scope}`,
        ),
      );
    if (this.db.dialect === 'postgres')
      statements.push(
        this.sql(
          'SELECT id FROM research_indexing_jobs WHERE id=? AND content_hash=? FOR UPDATE',
          job.id,
          job.content_hash,
        ),
      );
    if (this.db.dialect !== 'postgres')
      statements.push(
        this.sql(
          'DELETE FROM research_chunks_fts WHERE chunk_id IN (SELECT id FROM research_chunks WHERE source_id=?) AND EXISTS (SELECT 1 FROM research_indexing_jobs WHERE id=? AND content_hash=?)',
          job.id,
          job.id,
          job.content_hash,
        ),
      );
    statements.push(
      this.sql(
        'DELETE FROM research_chunks WHERE source_id=? AND EXISTS (SELECT 1 FROM research_indexing_jobs WHERE id=? AND content_hash=?)',
        job.id,
        job.id,
        job.content_hash,
      ),
    );
    statements.push(
      this.sql(
        'INSERT INTO research_sources (id,owner_scope,source_url,blob_key,content_hash,model_revision,updated_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM research_indexing_jobs WHERE id=? AND content_hash=?) ON CONFLICT(id) DO UPDATE SET blob_key=excluded.blob_key,content_hash=excluded.content_hash,model_revision=excluded.model_revision,updated_at=excluded.updated_at',
        job.id,
        job.owner_scope,
        job.source_url,
        job.blob_key,
        job.content_hash,
        this.embedder.revision,
        new Date().toISOString(),
        job.id,
        job.content_hash,
      ),
    );
    chunks.forEach((text, ordinal) =>
      statements.push(...this.chunkStatements(job, ordinal, text, embeddings[ordinal]!)),
    );
    statements.push(
      this.sql(
        "UPDATE research_indexing_jobs SET status='complete',error=NULL,updated_at=? WHERE id=? AND content_hash=?",
        new Date().toISOString(),
        job.id,
        job.content_hash,
      ),
    );

    return statements;
  }

  private chunkStatements(
    job: Job,
    ordinal: number,
    text: string,
    embedding: number[],
  ): AppStatement[] {
    const statements: AppStatement[] = [];
    const id = `${job.id}:${ordinal}`;
    statements.push(
      this.sql(
        'INSERT INTO research_chunks (id,source_id,owner_scope,ordinal,text,embedding,model_revision) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM research_indexing_jobs WHERE id=? AND content_hash=?)',
        id,
        job.id,
        job.owner_scope,
        ordinal,
        text,
        JSON.stringify(embedding),
        this.embedder.revision,
        job.id,
        job.content_hash,
      ),
    );
    if (this.db.dialect !== 'postgres')
      statements.push(
        this.sql(
          'INSERT INTO research_chunks_fts(chunk_id,owner_scope,text) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM research_indexing_jobs WHERE id=? AND content_hash=?)',
          id,
          job.owner_scope,
          text,
          job.id,
          job.content_hash,
        ),
      );

    return statements;
  }

  private async runJob(job: Job, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.sql(
      "INSERT INTO app_settings(key,value) VALUES(?,'active') ON CONFLICT(key) DO NOTHING",
      `research_owner:${job.owner_scope}`,
    ).run();
    await this.sql(
      "UPDATE research_indexing_jobs SET status='running',attempts=attempts+1,error=NULL,updated_at=? WHERE id=? AND content_hash=?",
      new Date().toISOString(),
      job.id,
      job.content_hash,
    ).run();
    try {
      const object = await this.blobs.get(job.blob_key);
      if (!object) throw new Error('Indexed page blob is missing.');
      const markdown = await object.text();
      if (hash(markdown) !== job.content_hash)
        throw new Error('Indexed page content hash mismatch.');
      const chunks = chunkMarkdown(markdown);
      const embeddings: number[][] = [];
      for (let i = 0; i < chunks.length; i += 8)
        embeddings.push(...(await this.embedder.embed(chunks.slice(i, i + 8), signal)));
      signal.throwIfAborted();
      const current = await this.sql(
        'SELECT content_hash FROM research_indexing_jobs WHERE id=?',
        job.id,
      ).first<{ content_hash: string }>();
      if (current?.content_hash !== job.content_hash) return;
      await this.db.batch(this.replacementStatements(job, chunks, embeddings));
    } catch (error) {
      await this.sql(
        "UPDATE research_indexing_jobs SET status='failed',error=?,updated_at=? WHERE id=? AND content_hash=?",
        'indexing_failed',
        new Date().toISOString(),
        job.id,
        job.content_hash,
      ).run();
      throw error;
    }
  }
  upsert: SavedSources['upsert'] = (source, signal) =>
    this.serial(async () => {
      signal.throwIfAborted();
      if (
        await this.sql(
          "SELECT 1 FROM app_settings WHERE key=? AND value='deleted'",
          `research_owner:${source.ownerScope}`,
        ).first()
      )
        throw new Error('Research owner index was deleted.');
      const url = publicUrl(source.url).toString();
      const markdown = source.markdown.slice(0, 64_000);
      const id = hash(`${source.ownerScope}\0${url}`);
      const contentHash = hash(markdown);
      const key = `research/owners/${hash(source.ownerScope)}/${id}/${contentHash}.md`;
      await this.blobs.put(key, markdown, {
        httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
        customMetadata: { source_url: url, owner_scope: source.ownerScope },
      });
      const previous = await this.sql(
        'SELECT content_hash,model_revision FROM research_sources WHERE id=? AND owner_scope=?',
        id,
        source.ownerScope,
      ).first<{ content_hash: string; model_revision: string }>();
      const alreadyIndexed =
        previous?.content_hash === contentHash &&
        previous.model_revision === this.embedder.revision;
      const job: Job = {
        id,
        owner_scope: source.ownerScope,
        source_url: url,
        blob_key: key,
        content_hash: contentHash,
      };
      await this.admitJob(job, alreadyIndexed ? 'complete' : 'pending');
      if (alreadyIndexed) return { id, status: 'complete' };
      try {
        await this.runJob(job, signal);
        return { id, status: 'complete' };
      } catch (error) {
        if (signal.aborted) throw error;
        return { id, status: 'failed', reason: 'indexing_unavailable' };
      }
    });
  search: SavedSources['search'] = async (ownerScope, query, signal) => {
    signal.throwIfAborted();
    const [vector] = await this.embedder.embed([query], signal);
    // Semantic retrieval scans ALL this owner's chunks, not a lexical shortlist.
    const all = (
      await this.sql(
        'SELECT c.id,c.text,c.embedding,c.model_revision,s.source_url FROM research_chunks c JOIN research_sources s ON s.id=c.source_id AND s.owner_scope=c.owner_scope WHERE c.owner_scope=?',
        ownerScope,
      ).all<Chunk>()
    ).results;
    const semantic = all
      .filter((chunk) => chunk.model_revision === this.embedder.revision)
      .map((chunk) => {
        try {
          return { id: chunk.id, score: cosine(vector!, JSON.parse(chunk.embedding)) };
        } catch {
          return { id: chunk.id, score: 0 };
        }
      })
      .filter((row) => row.score > 0.1)
      .sort((a, b) => b.score - a.score)
      .slice(0, 100);
    const tokens = query.match(/[\p{L}\p{N}]+/gu)?.slice(0, 32) ?? [];
    let lexical: Array<{ id: string }> = [];
    if (tokens.length) {
      const statement =
        this.db.dialect === 'postgres'
          ? this.sql(
              "SELECT id FROM research_chunks WHERE owner_scope=? AND to_tsvector('english',text) @@ plainto_tsquery('english',?) ORDER BY ts_rank_cd(to_tsvector('english',text),plainto_tsquery('english',?)) DESC LIMIT 100",
              ownerScope,
              query,
              query,
            )
          : this.sql(
              'SELECT chunk_id AS id FROM research_chunks_fts WHERE owner_scope=? AND research_chunks_fts MATCH ? ORDER BY bm25(research_chunks_fts) LIMIT 100',
              ownerScope,
              tokens.map((token) => `"${token}"`).join(' OR '),
            );
      lexical = (await statement.all<{ id: string }>()).results;
    }
    const scores = new Map<string, number>();
    for (const ranking of [semantic, lexical])
      ranking.forEach((row, index) =>
        scores.set(row.id, (scores.get(row.id) ?? 0) + 1 / (60 + index + 1)),
      );
    const byId = new Map(all.map((chunk) => [chunk.id, chunk]));
    const results = [...scores]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .flatMap(([id, score]) => {
        const chunk = byId.get(id);
        return chunk ? [{ url: chunk.source_url, text: chunk.text.slice(0, 4000), score }] : [];
      });
    signal.throwIfAborted();
    return { query, results };
  };
  deleteOwner: SavedSources['deleteOwner'] = (ownerScope) =>
    this.serial(async () => {
      const statements = [
        this.sql(
          "INSERT INTO app_settings(key,value) VALUES(?,'deleted') ON CONFLICT(key) DO UPDATE SET value='deleted'",
          `research_owner:${ownerScope}`,
        ),
      ];
      if (this.db.dialect !== 'postgres')
        statements.push(
          this.sql('DELETE FROM research_chunks_fts WHERE owner_scope=?', ownerScope),
        );
      statements.push(
        this.sql('DELETE FROM research_chunks WHERE owner_scope=?', ownerScope),
        this.sql('DELETE FROM research_sources WHERE owner_scope=?', ownerScope),
        this.sql('DELETE FROM research_indexing_jobs WHERE owner_scope=?', ownerScope),
      );
      await this.db.batch(statements);
      while (true) {
        const page = await this.blobs.list({
          prefix: `research/owners/${hash(ownerScope)}/`,
          limit: 1000,
        });
        if (page.objects.length) await this.blobs.delete(page.objects.map((object) => object.key));
        if (!page.truncated) break;
      }
    });
  resume = (signal = new AbortController().signal) =>
    this.serial(async () => {
      const jobs = (
        await this.sql(
          "SELECT j.id,j.owner_scope,j.source_url,j.blob_key,j.content_hash FROM research_indexing_jobs j LEFT JOIN research_sources s ON s.id=j.id WHERE j.status IN ('pending','running','failed') OR s.model_revision<>?",
          this.embedder.revision,
        ).all<Job>()
      ).results;
      for (const job of jobs) {
        signal.throwIfAborted();
        try {
          await this.runJob(job, signal);
        } catch (error) {
          if (signal.aborted) throw error;
        }
      }
    });
}

export function createLocalSavedSources(options: {
  db: AppDatabase;
  blobs: ObjectStore;
  embedder: ResearchEmbedder;
}) {
  return new LocalSavedSources(options.db, options.blobs, options.embedder);
}
