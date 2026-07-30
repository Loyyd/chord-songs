import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        ws: true
      },
      '/data': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true
      }
    }
  }
});

// https://vitejs.dev/config/
//192.168.0.61:5173
