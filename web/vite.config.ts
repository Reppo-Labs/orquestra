import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Dev: `npm run dev` proxies /api to a locally running node (port 7070).
// Build: emits into dist/dashboard/public so the dashboard server (compiled to
// dist/dashboard/server.js) serves the SPA from a sibling `public/` dir.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:7070' } },
  build: { outDir: '../dist/dashboard/public', emptyOutDir: true },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
