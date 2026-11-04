import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
  preview: {
    port: 5173,
    proxy: { '/api': 'http://localhost:4000' },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules/recharts') || id.includes('node_modules/d3-')) return 'charts';
          if (id.includes('node_modules/leaflet') || id.includes('node_modules/@geoman-io')) return 'maps';
          return undefined;
        },
      },
    },
  },
});
