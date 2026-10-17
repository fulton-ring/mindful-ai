import { serve } from '@hono/node-server';
import { assertNodeVersion, readNodeConfig } from './config';
import { createNodeRuntime } from './runtime';

assertNodeVersion();
const config = readNodeConfig();
const runtime = await createNodeRuntime(config, {
  migrate: config.role === 'all' || config.role === 'migrate',
  maintenance: config.role === 'migrate',
});
if (config.role === 'migrate') {
  await runtime.close();
} else {
  const server = serve({ fetch: runtime.fetch, hostname: config.host, port: config.port }, () => {
    console.info(`Walden ${config.role} listening on ${config.host}:${config.port}`);
  });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 30_000);
    timeout.unref();
    server.close();
    try {
      await runtime.close();
    } finally {
      clearTimeout(timeout);
    }
  };
  process.once('SIGTERM', () => {
    void stop();
  });
  process.once('SIGINT', () => {
    void stop();
  });
}
