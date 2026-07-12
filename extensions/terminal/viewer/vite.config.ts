import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  root: __dirname,
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@remux\/terminal$/,
        replacement: path.resolve(__dirname, './src/index.ts'),
      },
      { find: '@', replacement: path.resolve(__dirname, '../../..') },
    ],
  },
});
