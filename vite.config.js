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
        v1:   resolve(__dirname, 'v1/index.html'),
        v2:   resolve(__dirname, 'v2/index.html'),
      }
    }
  }
})
