// @vitejs/plugin-react is not needed for federation remotes. The spiceflow
// plugin enables OXC JSX transform and disables Fast Refresh automatically,
// since federation client chunks are loaded cross-origin by consumers.
import { defineConfig } from 'vite'
import spiceflow from 'spiceflow/vite'

// REMOTE_ORIGIN must be set to the remote's public URL so all built asset
// paths (JS chunks, CSS) are absolute. Without this, the host browser would
// fetch them relative to the host origin and get 404s.
const remoteOrigin = process.env.REMOTE_ORIGIN || 'http://localhost:3051'

export default defineConfig({
  base: remoteOrigin,
  clearScreen: false,
  server: {
    cors: true,
  },
  plugins: [
    spiceflow({
      entry: './src/main.tsx',
      externalizeShared: true,
    }),
  ],
})
