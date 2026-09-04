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
      external: [
        /^@anthropic-ai\/claude-agent-sdk$/,
        /^@modelcontextprotocol\/sdk(?:\/.*)?$/,
        /^typebox$/,
        /^ws$/,
        /^zod(?:\/.*)?$/,
      ],
      output: {
        entryFileNames: 'main.mjs',
      },
    },
    ssr: 'src/main.ts',
    target: 'node24',
  },
});
