import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    environment: 'node',
    // node:sqlite is newer than Vite's builtin externals list — keep it external
    // so it loads from the Node runtime instead of being bundled/resolved.
    server: { deps: { external: ['node:sqlite'] } },
  },
})
