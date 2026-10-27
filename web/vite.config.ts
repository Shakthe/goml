/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// The app is written against the React API; Preact's compat layer runs it at a
// fraction of the size (about 15 KB instead of about 190 KB raw).
export default defineConfig({
  plugins: [preact()],
  server: { proxy: { '/api': 'http://localhost:8080' } },
  build: { target: 'es2020', sourcemap: false },
  test: { environment: 'node' },
});
