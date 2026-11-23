import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/helpers/cli-path-global-setup.ts'],
    setupFiles: ['./tests/helpers/cli-path-setup.ts'],
  },
})
