import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies to a manager started with REQUIRE_CF_ACCESS=false and
// DEV_USER set, so the SPA can be developed against a real backend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.MCTL_API || 'http://localhost:8080',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
