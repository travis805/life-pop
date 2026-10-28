import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the SPA and proxies /api to a local `wrangler dev` (npm run cf:dev, port 8787).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8787' } },
});
