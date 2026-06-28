import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/viewers/codex/',
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      {
        find: /^@remux\/codex\/styles\.css$/,
        replacement: path.resolve(__dirname, './styles.css'),
      },
      {
        find: /^@remux\/codex$/,
        replacement: path.resolve(__dirname, './index.ts'),
      },
      { find: '@', replacement: path.resolve(__dirname, '../../..') },
    ],
  },
});
