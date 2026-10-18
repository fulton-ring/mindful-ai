import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

// Astro loads .env after this config; read the advertised local site setting here.
const envFile = new URL('.env', import.meta.url);
const localEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};

// Static output: the landing page is plain HTML served from Workers static assets.
// React is available for interactive islands (`client:visible` etc.); pages stay
// zero-JS unless a component opts in.
export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || localEnv.PUBLIC_SITE_URL || 'http://localhost:4321',
  output: 'static',
  integrations: [react()],
  // three.js is one ~560 kB chunk, loaded after the page's text is up.
  vite: { build: { chunkSizeWarningLimit: 700 } },
});
