import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Bundled, so the prerender step can run without the workspace's TypeScript sources.
  ssr: { noExternal: ['@yap/shared', 'lucide-react'] },
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
    // Never inline: the content security policy allows fonts from this site only, not data: URLs.
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: { main: 'index.html', landing: 'landing.html' },
      output: {
        // Priorities matter: a group also takes its dependencies, so without them React lands in
        // "charts", and the public page would download the whole chart library to show a form.
        advancedChunks: {
          groups: [
            { name: 'react', test: /node_modules[\\/](\.pnpm[\\/][^\\/]+[\\/]node_modules[\\/])?(react|react-dom|scheduler)[\\/]/, priority: 3 },
            { name: 'charts', test: /node_modules[\\/].*(recharts|d3-)/, priority: 2 },
            { name: 'maps', test: /node_modules[\\/].*(leaflet|@geoman-io)/, priority: 2 },
          ],
        },
      },
    },
  },
});
