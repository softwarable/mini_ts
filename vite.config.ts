import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { resolve } from 'node:path'
import { demoApi } from './demo/api.ts'
import { testApi } from './tests-browser/server.ts'

export default defineConfig({
  root: resolve(import.meta.dirname, 'demo'),
  plugins: [demoApi()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    lib: { entry: resolve(import.meta.dirname, 'mini.ts'), formats: ['es'], fileName: () => 'mini.js' },
    minify: false,
    sourcemap: true,
  },
  test: {
    root: import.meta.dirname,
    projects: [
      {
        // Fast unit tests in a simulated DOM.
        test: {
          name: 'unit',
          root: import.meta.dirname,
          environment: 'happy-dom',
          environmentOptions: { happyDOM: { url: 'http://localhost:3000/' } },
          include: ['tests/**/*.test.ts'],
        },
      },
      {
        // Real Chromium (Playwright) for what a simulated DOM can't show. Needs Playwright's Chromium
        // build that matches the pinned `playwright` version (npx playwright install chromium).
        root: import.meta.dirname,
        plugins: [testApi()],
        test: {
          name: 'browser',
          include: ['tests-browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
})
