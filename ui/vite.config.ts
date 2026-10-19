import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The SPA is built into ui/dist and served by the achromat-mom Worker through
// Workers Static Assets (see ../wrangler.toml [assets]). Production output must
// stay compatible with the strict CSP in public/_headers: external scripts and
// stylesheets only, nothing inlined.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // Never inline assets as data: URIs, so fonts and media stay under 'self'.
    assetsInlineLimit: 0,
    // Target browsers support modulepreload natively; skip the polyfill.
    modulePreload: { polyfill: false },
  },
  server: {
    // `npm run dev` (wrangler dev) serves the Worker API on :8787.
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/admin': 'http://127.0.0.1:8787',
    },
  },
})
