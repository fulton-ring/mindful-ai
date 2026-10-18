import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { assertNodeVersion, readNodeConfig } from './config';

it('keeps default native runtime state in a hidden data directory', () => {
  const config = readNodeConfig({});
  expect(config.dataDir).toBe(resolve('.data'));
  expect(config.sqlitePath).toBe(resolve('.data/walden.sqlite'));
  expect(config.filesDir).toBe(resolve('.data/files'));
});

it('defaults to a single process with persistent local SQLite and files', () => {
  const config = readNodeConfig({ DATA_DIR: '/tmp/walden-test' });
  expect(config).toMatchObject({
    role: 'all',
    host: '0.0.0.0',
    port: 3000,
    appUrl: 'http://localhost:3000',
    dataDir: '/tmp/walden-test',
    sqlitePath: '/tmp/walden-test/walden.sqlite',
    fileStorage: 'local',
    filesDir: '/tmp/walden-test/files',
  });
});
it('accepts a complete distributed Postgres/S3/Valkey profile', () => {
  expect(
    readNodeConfig({
      APP_ROLE: 'http',
      DATABASE_URL: 'postgres://host/app',
      FILE_STORAGE: 's3',
      S3_BUCKET: 'bucket',
      S3_REGION: 'us-east-1',
      VALKEY_URL: 'redis://cache:6379',
      APP_URL: 'https://walden.example/',
    }),
  ).toMatchObject({
    role: 'http',
    appUrl: 'https://walden.example',
    databaseUrl: 'postgres://host/app',
    fileStorage: 's3',
    valkeyUrl: 'redis://cache:6379',
  });
});
it.each([
  { PORT: 'invalid' },
  { PORT: '65536' },
  { APP_ROLE: 'unknown' },
  { DATABASE_URL: 'mysql://host/db' },
  { APP_REPLICAS: '2' },
  {
    APP_REPLICAS: '2',
    DATABASE_URL: 'postgres://host/db',
    FILE_STORAGE: 's3',
    S3_BUCKET: 'bucket',
  },
  { APP_ROLE: 'worker' },
  { FILE_STORAGE: 's3' },
  { APP_URL: 'https://user:password@example.com' },
  { APP_URL: 'https://example.com/subpath' },
  {
    APP_ROLE: 'http',
    DATABASE_URL: 'postgres://host/app',
    FILE_STORAGE: 'local',
    VALKEY_URL: 'redis://cache',
  },
  {
    APP_ROLE: 'http',
    DATABASE_URL: 'postgres://host/app',
    FILE_STORAGE: 's3',
    S3_BUCKET: 'bucket',
  },
])('rejects incompatible or partial runtime configuration %j', (env) => {
  expect(() => readNodeConfig(env)).toThrow();
});

it('enforces the SQLite FTS5 runtime minimum', () => {
  expect(() => assertNodeVersion('22.13.1')).toThrow(/24.15/);
  expect(() => assertNodeVersion('24.14.0')).toThrow();
  expect(() => assertNodeVersion('24.15.0')).not.toThrow();
});
