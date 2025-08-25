import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import type { ProxyOptions } from 'vite';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ''); // loads from .env, .env.local, etc.
  const OPENAI_API_KEY = env.OPENAI_API_KEY || '';

  return {
    plugins: [react()],
    optimizeDeps: {
      exclude: ['lucide-react'],
    },
    server: {
      proxy: {
        '/openai': {
          target: 'https://api.openai.com/v1',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/openai/, ''),
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
        } as ProxyOptions,
      },
    },
  };
});
