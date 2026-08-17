import { defineConfig } from 'vitest/config';

// Deliberately NOT reusing vite.config.ts. That config loads @crxjs/vite-plugin,
// which rewrites the module graph for an MV3 build and has no business running
// during unit tests. The tests here are plain functions — no DOM, no bundler.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
