import { fileURLToPath } from 'node:url';

// Keep local state beside the root package.json, independent of package-manager cwd changes.
process.chdir(fileURLToPath(new URL('../', import.meta.url)));
process.env.APP_ROOT ??= 'apps/api';
process.env.EMBEDDING_MODEL_DIR ??= '.cache/models/minilm';
await import('../apps/api/dist/node/server.js');
