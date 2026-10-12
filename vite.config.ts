import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { plannotatorReadonly } from './plannotator-readonly';

export default defineConfig({
  plugins: [plannotatorReadonly(), react()],
  optimizeDeps: { exclude: ['@plannotator/ui'] },
  resolve: {
    dedupe: ['react', 'react-dom', '@codemirror/state', '@codemirror/view'],
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:4310', '/mcp': 'http://127.0.0.1:4310' },
  },
  build: { target: 'es2022', sourcemap: false },
});
