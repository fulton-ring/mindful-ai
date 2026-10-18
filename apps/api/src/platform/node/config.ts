import { resolve } from 'node:path';

export const NODE_ROLES = ['all', 'http', 'worker', 'scheduler', 'migrate'] as const;
export type NodeRole = (typeof NODE_ROLES)[number];
export type NodeConfig = {
  role: NodeRole;
  appRoot: string;
  publicDir: string;
  embeddingModelDir: string;
  embeddingRevision: string;
  chromiumExecutablePath?: string;
  host: string;
  port: number;
  appUrl: string;
  dataDir: string;
  databaseUrl?: string;
  sqlitePath: string;
  fileStorage: 'local' | 's3';
  filesDir: string;
  valkeyUrl?: string;
  replicas: number;
  s3: {
    endpoint?: string;
    publicEndpoint?: string;
    region: string;
    bucket?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    forcePathStyle: boolean;
  };
};
const positiveInteger = (
  name: string,
  value: string | undefined,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max)
    throw new Error(`${name} must be an integer from 1 to ${max}`);
  return parsed;
};
const url = (name: string, value: string, protocols: string[]) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!protocols.includes(parsed.protocol)) throw new Error(`${name} uses an unsupported protocol`);
  return parsed;
};
const boolean = (name: string, value: string | undefined, fallback: boolean) => {
  if (value === undefined) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${name} must be true or false`);
};

function storage(env: NodeJS.ProcessEnv): Pick<NodeConfig, 'fileStorage' | 's3'> {
  const fileStorage = env.FILE_STORAGE ?? 'local';
  if (fileStorage !== 'local' && fileStorage !== 's3')
    throw new Error('FILE_STORAGE must be local or s3');
  const s3 = {
    endpoint: env.S3_ENDPOINT,
    publicEndpoint: env.S3_PUBLIC_ENDPOINT,
    region: env.S3_REGION ?? 'us-east-1',
    bucket: env.S3_BUCKET,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: boolean('S3_FORCE_PATH_STYLE', env.S3_FORCE_PATH_STYLE, true),
  };
  if (fileStorage === 's3') {
    if (!s3.bucket) throw new Error('S3_BUCKET is required with FILE_STORAGE=s3');
    if (s3.endpoint) url('S3_ENDPOINT', s3.endpoint, ['http:', 'https:']);
    if (s3.publicEndpoint) url('S3_PUBLIC_ENDPOINT', s3.publicEndpoint, ['http:', 'https:']);
    if (Boolean(s3.accessKeyId) !== Boolean(s3.secretAccessKey))
      throw new Error('S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be supplied together');
  }
  return { fileStorage, s3 };
}

export function assertNodeVersion(version = process.versions.node): void {
  const [major, minor] = version.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 15))
    throw new Error('Self-hosting requires Node.js 24.15 or newer (SQLite FTS5 support)');
}

function validateDeployment(
  role: string,
  replicas: number,
  databaseUrl: string | undefined,
  valkeyUrl: string | undefined,
  fileStorage: string,
): void {
  if (replicas > 1 && (!databaseUrl || !valkeyUrl || fileStorage !== 's3'))
    throw new Error('Multiple replicas require PostgreSQL, VALKEY_URL and S3 storage');
  if (role === 'http' || role === 'worker' || role === 'scheduler') {
    if (!databaseUrl || !valkeyUrl || fileStorage !== 's3')
      throw new Error('Split roles require PostgreSQL, VALKEY_URL and S3 storage');
  }
}

export function readNodeConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  assertNodeVersion();
  const role = env.APP_ROLE ?? 'all';
  if (!(NODE_ROLES as readonly string[]).includes(role))
    throw new Error(`APP_ROLE must be ${NODE_ROLES.join(', ')}`);
  const port = positiveInteger('PORT', env.PORT, 3000, 65535);
  const appUrl = url('APP_URL', env.APP_URL ?? `http://localhost:${port}`, ['http:', 'https:']);
  if (appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash)
    throw new Error('APP_URL must be an origin without credentials, path, query or fragment');
  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl) url('DATABASE_URL', databaseUrl, ['postgres:', 'postgresql:']);
  const valkeyUrl = env.VALKEY_URL;
  if (valkeyUrl) url('VALKEY_URL', valkeyUrl, ['redis:', 'rediss:']);
  const replicas = positiveInteger('APP_REPLICAS', env.APP_REPLICAS, 1);
  const { fileStorage, s3 } = storage(env);
  validateDeployment(role, replicas, databaseUrl, valkeyUrl, fileStorage);
  const appRoot = resolve(env.APP_ROOT ?? process.cwd());
  const dataDir = resolve(env.DATA_DIR ?? './.data');
  return {
    role: role as NodeRole,
    appRoot,
    publicDir: resolve(env.PUBLIC_DIR ?? `${appRoot}/public`),
    embeddingModelDir: resolve(env.EMBEDDING_MODEL_DIR ?? `${appRoot}/models/minilm`),
    embeddingRevision: env.EMBEDDING_MODEL_REVISION ?? '751bff37182d3f1213fa05d7196b954e230abad9',
    chromiumExecutablePath: env.CHROMIUM_EXECUTABLE_PATH,
    host: env.HOST ?? '0.0.0.0',
    port,
    appUrl: appUrl.origin,
    dataDir,
    databaseUrl,
    sqlitePath: resolve(env.SQLITE_PATH ?? `${dataDir}/walden.sqlite`),
    fileStorage,
    filesDir: resolve(env.FILES_DIR ?? `${dataDir}/files`),
    valkeyUrl,
    replicas,
    s3,
  };
}
