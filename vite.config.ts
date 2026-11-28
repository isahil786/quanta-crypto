import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({ mode }) => {
  // Same port the API server reads from .env (PORT), so `dev:client` follows it
  const apiPort = loadEnv(mode, process.cwd(), '').PORT || '6001';
  const apiTarget = `http://127.0.0.1:${apiPort}`;
  return {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: { output: { manualChunks: { charts: ['lightweight-charts'], react: ['react', 'react-dom'] } } },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 5174,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/ws': { target: apiTarget, ws: true, changeOrigin: true },
      },
    },
  };
});
