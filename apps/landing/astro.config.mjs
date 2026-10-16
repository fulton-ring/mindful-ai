import react from '@astrojs/react';
import { defineConfig } from 'astro/config';

// Static output: the landing page is plain HTML served from Workers static assets.
// React is available for interactive islands (`client:visible` etc.); pages stay
// zero-JS unless a component opts in.
export default defineConfig({
  site: 'https://withwalden.app',
  output: 'static',
  integrations: [react()],
  // three.js is one ~560 kB chunk, loaded after the page's text is up.
  vite: { build: { chunkSizeWarningLimit: 700 } },
});
