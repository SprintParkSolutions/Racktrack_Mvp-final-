import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Deliberately separate from vite.config.js. That file carries the ngrok
// bundling gate, the dev proxy and the self-signed-cert plugin — none of which
// a test run should inherit, and all of which are easy to break by editing the
// file for an unrelated reason. Vitest picks this up in preference to
// vite.config.js, so the build config stays untouched.
export default defineConfig({
  plugins: [react()],
  test: {
    // The modules under test reach for window.localStorage, Image and canvas,
    // so a DOM is not optional here.
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{js,jsx}'],
    // Coverage measurement: turns "the tests pass" into "and here is how much
    // of the code they actually exercise". Run with `npm run test:coverage`.
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      include: ['src/**/*.{js,jsx}'],
      // Config, entry points and generated assets are not meaningful to cover.
      exclude: ['src/**/*.test.{js,jsx}', 'src/main.jsx', 'src/assets/**', 'src/fonts.css'],
    },
  },
});
