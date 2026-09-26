import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const apiPort = Number(env.PORT || process.env.PORT || 3002);
  const configuredBase = env.APP_BASE_PATH || process.env.APP_BASE_PATH || '/';
  const appBase = `/${configuredBase.split('/').filter(Boolean).join('/')}${configuredBase.split('/').filter(Boolean).length ? '/' : ''}`;
  const mountPath = appBase === '/' ? '' : appBase.slice(0, -1);
  const apiPath = `${mountPath}/api` || '/api';
  return {
    root: 'client',
    base: appBase,
    plugins: [react()],
    server: {
      proxy: {
        [apiPath]: {
          target: env.PROFILE_API_URL || `http://localhost:${apiPort}`,
          changeOrigin: true,
        },
      },
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
    },
  };
});
