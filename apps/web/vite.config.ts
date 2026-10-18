import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type ProxyOptions } from 'vite';

const developmentOrigins = new Set([
  'http://localhost:5173',
  'http://localhost:8788',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8788',
]);

export default defineConfig(() => {
  const cloudflare = process.env.WALDEN_DEV_CLOUDFLARE === '1';
  const port = cloudflare ? 5173 : Number(process.env.PORT || 3000);
  const apiPort = Number(process.env.WALDEN_API_PORT || port + 1);
  const proxy: ProxyOptions = {
    target: cloudflare ? 'http://localhost:8787' : `http://127.0.0.1:${apiPort}`,
    changeOrigin: true,
  };
  if (cloudflare)
    proxy.configure = (server) => {
      server.on('proxyReq', (proxyReq, request) => {
        const origin = request.headers.origin;
        if (origin && developmentOrigins.has(origin))
          proxyReq.setHeader('origin', 'http://localhost:8787');
      });
    };
  return {
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    envDir: '../..',
    plugins: [react(), tailwindcss()],
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      watch: { usePolling: true },
      proxy: {
        '/api': proxy,
        '/health': proxy,
      },
    },
    build: { sourcemap: false },
    test: {
      // CodeMirror and Testing Library setup put several of these tests within a
      // second of the 5s default, so they failed intermittently under the
      // parallel workspace run rather than on their own merits.
      testTimeout: 20_000,
      hookTimeout: 20_000,
      fileParallelism: false,
    },
  };
});
