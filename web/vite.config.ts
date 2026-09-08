import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:4123';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API and the UI are one product; proxying keeps the browser same-origin so the
    // dev server needs no CORS dance.
    proxy: {
      '/api': {
        target: API,
        configure(proxy) {
          // Vite's own handler answers a proxy failure with an empty 500, which the UI
          // can only render as "HTTP 500". Say what actually happened instead.
          proxy.on('error', (err, _req, res) => {
            if ('writeHead' in res && !res.headersSent) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  error:
                    `The API server is not running at ${API} (${err.message}). ` +
                    "Start it with 'npm run serve -w server' — the dev server only proxies /api to it.",
                }),
              );
            }
          });
        },
      },
    },
  },
  build: { outDir: 'dist' },
});
