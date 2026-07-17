import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  server: {
    port: 5173,
    strictPort: true,
    // Allow the chrome-extension:// origin to fetch Vite dev assets (@vite/env, HMR client, etc.).
    // Without this, the MV3 service worker fails to register because it can't load its module.
    cors: { origin: '*' },
    // Tell Vite to advertise this URL when generating module imports — keeps paths absolute and
    // avoids stale `chrome-extension://...` URLs leaking into the dev script graph.
    origin: 'http://localhost:5173',
    hmr: { port: 5173 },
  }
});
