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
    // No sourcemap in the shipped bundle: it would publish the full annotated
    // source, including every comment describing an authorization boundary.
    sourcemap: false,
    // Phase 6: minification was previously OFF, which shipped a ~2 MB bundle to
    // the analyst application. The Phase 6 gate requires that presentation work
    // not degrade operational performance, so this is now on. `true` selects
    // Vite 8's built-in oxc minifier — neither esbuild nor terser needs to be
    // installed, which is also why terser was removed as a dependency.
    minify: true,
    // Split the vendor libraries out of the application chunk so a change to a
    // page does not invalidate the cached copy of React and MUI.
    rollupOptions: {
      output: {
        // Function form: Vite 8 builds with rolldown, which does not accept the
        // object shorthand.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)) {
            return 'react'
          }
          if (/[\\/]node_modules[\\/](@mui|@emotion)[\\/]/.test(id)) return 'mui'
          // GSAP is only needed by the login opening and the panel reveals.
          if (/[\\/]node_modules[\\/](gsap|@gsap)[\\/]/.test(id)) return 'motion'
          return 'vendor'
        },
      },
    },
    chunkSizeWarningLimit: 900,
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
    // Phase 6: run the suite one file at a time.
    //
    // Several files render a full workflow screen and drive it with real
    // userEvent pointer/keyboard sequences. Run in parallel, they contend for
    // CPU badly enough on a developer laptop that unrelated tests exceed even
    // the raised 20s budget — the same file passes on its own and fails in a
    // full run, which is the worst possible signal from a gate. The suite is
    // fast enough serially that determinism is the better trade.
    fileParallelism: false,
  },
})
