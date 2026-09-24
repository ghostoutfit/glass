import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  base: '/glass/',
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        v3:   resolve(__dirname, 'v3/index.html'),
        v5:   resolve(__dirname, 'v5/index.html'),
      }
    }
  }
})
