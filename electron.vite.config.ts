import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: {
      input: { index: resolve('src/main/index.ts'), 'pi-extension': resolve('src/main/chat/pi-extension.ts'), 'dsh-host': resolve('src/main/dsh/host-entry.ts') },
      output: { entryFileNames: '[name].js' },
    } },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: {
      input: resolve('src/preload/index.ts'),
      output: { format: 'cjs', entryFileNames: 'index.cjs' },
    } },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    server: { host: '127.0.0.1', port: 4321, strictPort: true },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
