import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const apiOrigin = 'http://localhost:8787'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (upstream, request) => {
            // The Worker checks the browser's Origin. Translate only this dev
            // server's own origin as both sides of the proxy use different ports.
            if (request.headers.origin === `http://${request.headers.host}`) {
              upstream.setHeader('Origin', apiOrigin)
            }
          })
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
})
