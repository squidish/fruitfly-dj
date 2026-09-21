import { defineConfig } from 'vite';
import { earWorkletPlugin } from './vite-plugin-worklet.ts';

// GitHub Pages serves project sites from /<repo>/, so the base is configurable
// via BASE_PATH without touching the source.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [earWorkletPlugin()],
  build: { target: 'es2022' },
  worker: { format: 'es' },
});
