// Build do script de embed: um único .js (React + CSS embutidos), formato IIFE.
//   npm run build:embed  →  dist-embed/hub-ia-simulador.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'dist-embed',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: 'src/embed.tsx',
      name: 'HubIASimulador',
      formats: ['iife'],
      fileName: () => 'hub-ia-simulador.js',
    },
  },
});
