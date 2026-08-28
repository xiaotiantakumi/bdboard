import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import rootPackage from '../package.json';

export default defineConfig({
  plugins: [react()],
  define: {
    __BDBOARD_VERSION__: JSON.stringify(rootPackage.version),
  },
  server: {
    // The API proxy reaches the backend from 127.0.0.1. Exposing this listener
    // to the LAN would make remote clients look local to the backend and bypass
    // the local-only Basic Auth exemption.
    host: '127.0.0.1',
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
});
