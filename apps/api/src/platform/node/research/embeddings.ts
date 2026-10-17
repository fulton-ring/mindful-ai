import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface ResearchEmbedder {
  readonly revision: string;
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

/** Local-only MiniLM: installation bundles model files; requests never download weights. */
export function createLocalEmbedder(options: {
  modelDirectory: string;
  revision: string;
}): ResearchEmbedder {
  if (!options.revision.trim()) throw new Error('A pinned embedding model revision is required.');
  const directory = resolve(options.modelDirectory);
  let extractor:
    | Promise<(texts: string[], options: object) => Promise<{ tolist(): number[][] }>>
    | undefined;
  async function load() {
    await Promise.all(
      ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'].map((file) =>
        access(join(directory, file)),
      ),
    );
    const { pipeline, env } = await import('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    // Absolute paths are used so model resolution is independent of process cwd.
    return (await pipeline('feature-extraction', directory, {
      local_files_only: true,
      dtype: 'q8',
      device: 'cpu',
    })) as unknown as Awaited<NonNullable<typeof extractor>>;
  }
  return {
    revision: options.revision,
    async embed(texts, signal) {
      signal.throwIfAborted();
      extractor ??= load().catch((error) => {
        extractor = undefined;
        throw error;
      });
      const model = await extractor;
      const result = await model(texts, { pooling: 'mean', normalize: true });
      signal.throwIfAborted();
      const vectors = result.tolist();
      if (
        vectors.length !== texts.length ||
        vectors.some(
          (vector) => vector.length !== 384 || vector.some((value) => !Number.isFinite(value)),
        )
      )
        throw new Error('MiniLM returned invalid 384-dimensional embeddings.');
      return vectors;
    },
  };
}
