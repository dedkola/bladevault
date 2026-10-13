import { defineConfig } from 'eslint/config'
import next from 'eslint-config-next'

export default defineConfig([
  {
    ignores: [
      '**/.next/**',
      '**/dist/**',
      '**/node_modules/**',
      'static-app/out/**',
      '.wrangler/**',
    ],
  },
  {
    extends: [...next],
  },
  {
    files: ['**/*.{js,cjs,mjs}'],
    rules: {
      'no-unused-vars': 'error',
    },
  },
])
