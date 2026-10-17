import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';

// Opt-in only: resolves core from the isolated candidate installation.
// The normal app configuration and lockfile keep using their installed version.
const root = process.env.SPIKE_CANDIDATE_ROOT;
if (!root) throw new Error('Set SPIKE_CANDIDATE_ROOT to an isolated spike package directory.');
const candidate = createRequire(`${root}/package.json`);

export default defineConfig({
  plugins: [
    {
      name: 'isolated-mastra-candidate',
      enforce: 'pre',
      resolveId(id) {
        if (id === '@mastra/core' || id.startsWith('@mastra/core/')) return candidate.resolve(id);
      },
    },
  ],
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    include: [
      'src/**/*.test.ts',
      'tests/**/*.test.ts',
      'spikes/mastra-portability/compatibility.test.ts',
    ],
  },
});
