import { defineConfig } from 'vite';

export default defineConfig({
  // GitHub Pages serves the site from a sub-path: the workflow sets VITE_BASE=/<repo>/. Local dev keeps '/'.
  base: process.env.VITE_BASE ?? '/',
  server: {
    host: 'localhost',
    strictPort: true,
  },
  build: {
    target: 'es2022',
    // Rapier ships its WASM inlined as base64 (~4 MB, ~1.5 MB gzip), so that chunk is large by design.
    chunkSizeWarningLimit: 4500,
    rolldownOptions: {
      output: {
        // Vendor chunks: cached across game updates and downloaded in parallel.
        codeSplitting: {
          groups: [
            { name: 'rapier', test: /node_modules[\\/]@dimforge/ },
            { name: 'three', test: /node_modules[\\/]three/ },
          ],
        },
      },
    },
  },
});
