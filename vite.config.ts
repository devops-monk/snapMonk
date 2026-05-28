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
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
});