import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Where /api goes: the dev API, or another (HIVA_API) — the sweeps run a frozen copy beside it.
const api = { '/api': { target: process.env.HIVA_API ?? 'http://localhost:4000', changeOrigin: true } };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // `vite preview` of a build, proxied the same way: a stack no edit reloads under a sweep.
  preview: { port: 4173, proxy: api },
  server: {
    port: 5173,
    // Bind on all interfaces so the dev server is reachable at localhost, 127.0.0.1
    // and over the LAN (handy for checking the RTL layout on a phone).
    host: true,
    // The SPA talks to a same-origin /api path in dev, matching the production reverse proxy.
    proxy: api,
  },
  optimizeDeps: {
    // pdf.js (roadmap #38) is shipped as ready ES modules and loaded only when a PDF is annotated;
    // pre-bundling it on first use stalls the dev server, so it is served as it is.
    exclude: ['pdfjs-dist'],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        /*
         * Split the vendor bundle so the charting library — only needed on /reports —
         * is not downloaded by every user on first paint.
         */
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          query: ['@tanstack/react-query'],
          charts: ['recharts'],
        },
      },
    },
  },
});
