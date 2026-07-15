import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import spiceflow from 'spiceflow/vite'

export default defineConfig({
  clearScreen: false,
  plugins: [
    spiceflow({
      entry: './src/main.tsx',
      externalizeShared: true,
      importMap: {
        'framer-motion': 'https://esm.sh/framer-motion@12?external=react',
        'framer': 'https://esm.sh/unframer@4.1.5/dist/framer.mjs?external=react',
      },
    }),
    react(),
  ],
})
