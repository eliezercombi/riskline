import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths, so the same build runs inside an .ehpk and on any static host.
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
