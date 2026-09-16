/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { testApiPlugin } from './testApiPlugin';

export default defineConfig({
  plugins: [react(), testApiPlugin()],
  test: {
    environment: 'jsdom',
  },
});
