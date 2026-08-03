import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import webExtension from 'vite-plugin-web-extension';

export default defineConfig({
  plugins: [
    tailwindcss(),
    webExtension({
      manifest: './manifest.json',
      additionalInputs: [
        'src/editor/editor.html',
        'src/annotate/annotate.html',
        'src/preview/preview.html',
        'src/content/overlay.ts',
        'src/content/overlay.css',
        'src/recorder/recorder-toolbar.ts',
        'src/recorder/recorder-toolbar.css',
      ],
      disableAutoLaunch: true,
    }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    // Chrome extension pages don't use <link rel="modulepreload"> hints and log
    // "cross-world resource mismatch" warnings for them — disable module preload.
    modulePreload: false,
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});