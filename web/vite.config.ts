import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Dev: `npm run dev` proxies /api to a locally running node (port 7070).
// Build: emits into dist/dashboard/public so the dashboard server (compiled to
// dist/dashboard/server.js) serves the SPA from a sibling `public/` dir.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:7070' } },
  build: { outDir: '../dist/dashboard/public', emptyOutDir: true },
  // Default env stays node (api.test.ts, configDiff.test.ts, BudgetBurn.test.ts).
  // Render tests (*.render.test.tsx) opt into jsdom via a per-file
  // `// @vitest-environment jsdom` docblock — least blast radius.
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'node' },
})
