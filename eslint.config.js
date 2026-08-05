import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    ignores: ['node_modules/**', '.data/**', 'coverage/**', 'src/ui/vendor/**']
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node }
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-console': 'warn',
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error'
    }
  },
  {
    files: ['src/ui/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser }
    },
    rules: {
      'no-console': 'off'
    }
  },
  {
    files: ['test/**/*.js', 'tools/**/*.mjs', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off'
    }
  }
]
