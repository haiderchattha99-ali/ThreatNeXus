import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: false,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: false,
    // Vitest's 5s default is not enough for the Phase 3 workflow screens: a
    // single userEvent interaction with an MUI Select opens a portal, runs a
    // transition and re-renders a full page, and several test files run in
    // parallel jsdom environments on one machine. The tests themselves are
    // fast — the environment is not — so the budget is raised rather than the
    // interactions being replaced with fireEvent, which would stop exercising
    // the real keyboard/pointer sequence a user performs.
    testTimeout: 20000,
  },
})
