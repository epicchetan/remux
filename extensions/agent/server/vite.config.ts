import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
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
