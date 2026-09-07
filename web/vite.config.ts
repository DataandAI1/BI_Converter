import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API and the UI are one product; proxying keeps the browser same-origin so the
    // dev server needs no CORS dance.
    proxy: { '/api': 'http://127.0.0.1:4123' },
  },
  build: { outDir: 'dist' },
});
