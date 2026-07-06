import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
export default defineConfig({ plugins: [react()], resolve: { alias: { 'swiss/bridge': resolve(__dirname, 'src/swiss/swiss-bridge.js'), swiss: resolve(__dirname, 'src/swiss/swiss.js') } } });
