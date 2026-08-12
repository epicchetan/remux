import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: __dirname,
  publicDir: resolve(__dirname, 'prompts'),
  build: {
    emptyOutDir: true,
    minify: false,
    outDir: 'dist',
    rollupOptions: {
      external: [/^@earendil-works\//, /^typebox$/],
      output: {
        entryFileNames: 'main.mjs',
      },
    },
    ssr: 'src/main.ts',
    target: 'node24',
  },
});
