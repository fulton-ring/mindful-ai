import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Several suites spawn sqlite3 and build a full migration chain per fixture.
    // That runs close to the 5s default and tipped over under the parallel
    // workspace run, producing failures in a different file each time.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
