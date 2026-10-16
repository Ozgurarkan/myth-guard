import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'native-player',
  publicDir: '../public',
  base: './',
  plugins: [react()],
  // The nested output keeps this app independent of the GM web build, while
  // still giving Capacitor an index.html at the root of its configured webDir.
  build: { outDir: '../mobile/player/native-player', emptyOutDir: true },
});
