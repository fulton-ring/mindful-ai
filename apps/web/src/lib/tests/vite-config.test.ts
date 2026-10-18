import { EventEmitter } from 'node:events';
import { type ProxyOptions, resolveConfig, type UserConfigExport } from 'vite';
import { afterEach, expect, it, vi } from 'vitest';

import configuration from '../../../vite.config';

async function developmentConfig(config: UserConfigExport = configuration) {
  return typeof config === 'function' ? config({ command: 'serve', mode: 'development' }) : config;
}

function proxyFor(config: Awaited<ReturnType<typeof developmentConfig>>, path: string) {
  const proxy = config.server?.proxy?.[path];
  if (!proxy || typeof proxy === 'string') throw new Error(`Missing configured proxy: ${path}`);
  return proxy;
}

function forwardedOrigin(options: ProxyOptions, origin: string) {
  const proxy = new EventEmitter();
  options.configure?.(proxy as Parameters<NonNullable<ProxyOptions['configure']>>[0], options);
  const setHeader = vi.fn();
  proxy.emit('proxyReq', { setHeader }, { headers: { origin } });
  return setHeader.mock.calls.find(([name]) => name === 'origin')?.[1] ?? origin;
}

afterEach(() => vi.unstubAllEnvs());

it('defaults to a strict loopback standalone server and preserves the public origin', async () => {
  vi.stubEnv('WALDEN_DEV_CLOUDFLARE', undefined);
  vi.stubEnv('PORT', undefined);
  vi.stubEnv('WALDEN_API_PORT', undefined);
  const config = await developmentConfig();
  expect(config.server).toMatchObject({ host: '127.0.0.1', port: 3000, strictPort: true });
  for (const path of ['/api', '/health']) {
    const proxy = proxyFor(config, path);
    expect(proxy.target).toBe('http://127.0.0.1:3001');
    expect(forwardedOrigin(proxy, 'http://localhost:3000')).toBe('http://localhost:3000');
    expect(forwardedOrigin(proxy, 'http://localhost:5173')).toBe('http://localhost:5173');
  }
});

it('uses the standalone launcher ports without rewriting the UI origin', async () => {
  vi.stubEnv('WALDEN_DEV_CLOUDFLARE', '0');
  vi.stubEnv('PORT', '4200');
  vi.stubEnv('WALDEN_API_PORT', '4205');
  const config = await developmentConfig();
  expect(config.server?.port).toBe(4200);
  const proxy = proxyFor(config, '/api');
  expect(proxy.target).toBe('http://127.0.0.1:4205');
  expect(forwardedOrigin(proxy, 'http://localhost:4200')).toBe('http://localhost:4200');
});

it('retains the Cloudflare ports and allowlisted origin rewrite only when explicitly selected', async () => {
  vi.stubEnv('WALDEN_DEV_CLOUDFLARE', '1');
  vi.stubEnv('PORT', '4200');
  vi.stubEnv('WALDEN_API_PORT', '4205');
  const config = await developmentConfig();
  expect(config.server?.port).toBe(5173);
  const proxy = proxyFor(config, '/api');
  expect(proxy.target).toBe('http://localhost:8787');
  expect(forwardedOrigin(proxy, 'http://localhost:5173')).toBe('http://localhost:8787');
  expect(forwardedOrigin(proxy, 'https://untrusted.example')).toBe('https://untrusted.example');
});

it('exposes only the default VITE prefix when resolving environment variables', async () => {
  vi.stubEnv('VITE_CONFIG_TEST_VISIBLE', 'visible');
  vi.stubEnv('AI_API_KEY', 'private-ai-key');
  vi.stubEnv('OPENROUTER_API_KEY', 'private-router-key');
  vi.stubEnv('WALDEN_API_PORT', '4205');
  const config = await developmentConfig();
  const resolved = await resolveConfig({ ...config, configFile: false, plugins: [] }, 'serve');
  expect(resolved.env.VITE_CONFIG_TEST_VISIBLE).toBe('visible');
  const exposed = Object.keys(resolved.env);
  expect(exposed).not.toContain('AI_API_KEY');
  expect(exposed).not.toContain('OPENROUTER_API_KEY');
  expect(exposed).not.toContain('WALDEN_API_PORT');
});
