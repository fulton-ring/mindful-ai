import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AppDatabase } from '../../db/database';
import type { EntitlementsProvider } from '../../policy';
import type { ResearchBrowser, SavedSources } from '../../services/research/ports';
import type { DocumentExtractor } from '../../storage/document-extractor';
import { createLocalObjectStore } from '../../storage/local';
import type { ObjectStore } from '../../storage/object-store';
import { createS3ObjectStore } from '../../storage/s3';
import type { NodeConfig } from './config';
import { createNodeDocumentExtractor } from './documents/extractor';
import { createPlaywrightResearchBrowser } from './research/browser';
import { createLocalEmbedder } from './research/embeddings';
import { createLocalSavedSources } from './research/saved-sources';

export type NodeRuntimeLifecycle = {
  ready?(): void | Promise<void>;
  close?(): void | Promise<void>;
};
export type NodeRuntimeService<T> = T & NodeRuntimeLifecycle;
type Provider<T> = NodeRuntimeService<T> | Promise<NodeRuntimeService<T>>;
export type NodeSavedSources = SavedSources & {
  /** Omit for indexes whose background work is managed by the provider. */
  resume?(signal: AbortSignal): Promise<void>;
};

/** Explicit composition hooks; absent factories select the shipped Node providers. */
export interface NodeRuntimeAdapters {
  /** Absent by default; standalone deployments require no billing provider. */
  createEntitlementsProvider?(
    config: NodeConfig,
    context: { db: AppDatabase },
  ): Provider<EntitlementsProvider>;
  createObjectStore?(config: NodeConfig): Provider<ObjectStore>;
  createDocumentExtractor?(config: NodeConfig): Provider<DocumentExtractor>;
  createResearchBrowser?(config: NodeConfig): Provider<ResearchBrowser>;
  createSavedSources?(
    config: NodeConfig,
    context: { db: AppDatabase; blobs: ObjectStore },
  ): Provider<NodeSavedSources>;
}

export const defaultNodeRuntimeAdapters: Required<
  Omit<NodeRuntimeAdapters, 'createEntitlementsProvider'>
> = {
  createObjectStore(config) {
    return config.fileStorage === 's3'
      ? createS3ObjectStore({
          ...config.s3,
          bucket: config.s3.bucket!,
          credentials: config.s3.accessKeyId
            ? { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey! }
            : undefined,
        })
      : createLocalObjectStore(config.filesDir);
  },
  async createDocumentExtractor(config) {
    const worker = join(config.appRoot, 'dist/node/document-worker.js');
    await stat(worker);
    return createNodeDocumentExtractor({ workerUrl: pathToFileURL(worker) });
  },
  createResearchBrowser: () => createPlaywrightResearchBrowser(),
  async createSavedSources(config, context) {
    await Promise.all(
      ['config.json', 'tokenizer.json', 'onnx/model_quantized.onnx'].map((name) =>
        stat(join(config.embeddingModelDir, name)),
      ),
    );
    return createLocalSavedSources({
      ...context,
      embedder: createLocalEmbedder({
        modelDirectory: config.embeddingModelDir,
        revision: config.embeddingRevision,
      }),
    });
  },
};
