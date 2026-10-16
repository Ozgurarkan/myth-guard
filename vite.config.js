import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { realmVitePlugin } from './server/net/vitePlugin.js'

export default defineConfig({
  cacheDir: 'node_modules/.vite/realm-forge-5173',
  plugins: [react(), realmVitePlugin()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/artifacts/**', '**/.npm-cache/**', '**/.tools/**', '**/.backup-pre-redesign/**', '**/dist/**'],
    },
  },
  preview: {
    host: '0.0.0.0',
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      input: {
        main: './index.html',
        player: './player.html',
      },
      output: {
        // The GM and player pages share these, so a phone downloads them once.
        manualChunks(id) {
          if (/node_modules\/(react|react-dom|scheduler|react-reconciler|its-fine)\//.test(id)) return 'react';
          if (/node_modules\/(konva|react-konva|use-image)\//.test(id)) return 'konva';
          return undefined;
        },
      },
    },
  },
})
