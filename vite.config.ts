import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    lib: { entry: 'src/main.ts', name: 'RobotDataViewer', formats: ['iife'], fileName: () => 'viewer.js' },
    cssCodeSplit: false,
    sourcemap: false,
    rollupOptions: { output: { inlineDynamicImports: true, assetFileNames: 'viewer.[ext]' } },
  },
});
