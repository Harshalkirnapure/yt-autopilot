import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `npm run dev` serves the studio on 5173 and forwards API calls to the Fastify backend, so the
 * session cookie stays same-origin from the browser's point of view.
 *
 * `npm run build` writes frontend/dist, which the backend serves directly when it exists, so the
 * production path is a single process on http://localhost:3000.
 */
const backendOrigin = process.env.BACKEND_ORIGIN || 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: backendOrigin },
      '/uploads': { target: backendOrigin },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
