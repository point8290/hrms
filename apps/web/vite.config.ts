import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The browser talks to the API through this proxy in development, so the app ships
    // one origin and needs no CORS configuration locally.
    //
    // `/internal` is here because the local storage driver hands out presigned URLs on that
    // path rather than at a bucket host. A browser resolves them against its own origin, so
    // without this entry every document upload and download 404s in development while
    // working perfectly in production — the kind of gap that only shows up when somebody
    // actually attaches a file.
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
      '/internal': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
