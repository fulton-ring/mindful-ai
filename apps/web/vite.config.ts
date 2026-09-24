import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const developmentOrigins = new Set([
  'http://localhost:5173',
  'http://localhost:8788',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8788',
]);

export default defineConfig({
  envDir: '../..',
  plugins: [react(), tailwindcss()],
  server: {
    watch: { usePolling: true },
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyReq, request) => {
            const origin = request.headers.origin;
            if (origin && developmentOrigins.has(origin)) {
              proxyReq.setHeader('origin', 'http://localhost:8787');
            }
          });
        },
      },
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
});
