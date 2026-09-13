import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4200',
      '/socket.io': { target: 'http://127.0.0.1:4200', ws: true, changeOrigin: true },
    },
  },
})
