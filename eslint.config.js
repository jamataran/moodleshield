import js from '@eslint/js'
import globals from 'globals'

/**
 * Sintaxis que ES2021 admite pero rompe el visor en navegadores que hay que
 * seguir atendiendo (ADR-036). Un módulo que no compila no ejecuta nada: ni
 * siquiera el resto de líneas que sí entendería.
 */
export const SUELO_DEL_VISOR = [
  {
    selector: 'AssignmentExpression[operator=/^(\\?\\?|\\|\\||&&)=$/]',
    message: 'Asignación lógica (??=, ||=, &&=): Safari < 14 no la entiende.'
  },
  {
    selector: 'Literal[regex.pattern=/\\(\\?<[=!]/]',
    message: 'Lookbehind en una expresión regular: Safari < 16.4 no compila el módulo entero.'
  },
  {
    selector: 'Literal[regex.pattern=/\\(\\?<[^=!]|\\\\[pP]\\{/]',
    message: 'Grupo con nombre o \\p{…} en una expresión regular: Firefox < 78 no compila el módulo entero.'
  },
  {
    selector: 'Literal[regex.flags=/s/]',
    message: 'Flag s (dotAll) en una expresión regular: Firefox < 78 no compila el módulo entero.'
  },
  {
    selector: 'Literal[bigint]',
    message: 'BigInt: Safari < 14 no lo entiende.'
  },
  {
    selector: 'ExportAllDeclaration[exported]',
    message: '`export * as`: Firefox < 80 y Safari < 14.1 no lo entienden.'
  }
]

export default [
  {
    // `.claude/**` son worktrees y ajustes locales de agentes: copias del
    // repositorio que se colarían en el informe como errores duplicados.
    ignores: ['node_modules/**', '.data/**', 'coverage/**', 'src/ui/vendor/**', '.claude/**']
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
    // El visor del alumno tiene que arrancar en navegadores de 2020 (ADR-036):
    // nada posterior a ES2021 —ni `await` en el nivel superior ni campos de
    // clase— y tampoco lo que ES2021 admite pero esos navegadores no. La lista la
    // vigila test/ui-compat.test.js recorriendo los imports desde cada entrada.
    files: [
      'src/ui/assets/player.js',
      'src/ui/assets/pdf.js',
      'src/ui/assets/collection.js',
      'src/ui/assets/video-component.js',
      'src/ui/assets/viewer-shell.js',
      'src/ui/assets/dialog.js',
      'src/ui/assets/progress-client.js',
      'src/ui/assets/telemetry-client.js',
      'src/ui/assets/pdf-component.js',
      'src/ui/assets/pdf-mark.js',
      'src/ui/assets/pdf-download.js',
      'src/ui/assets/pdfjs-worker.js',
      'src/ui/assets/pdfjs-polyfills.js',
      'src/ui/assets/compat-informe.js'
    ],
    languageOptions: { ecmaVersion: 2021 },
    rules: {
      'no-restricted-syntax': ['error', ...SUELO_DEL_VISOR]
    }
  },
  {
    // La guardia de arranque se ejecuta en CUALQUIER navegador, también en el
    // que no entiende módulos: ES5 y script clásico.
    files: ['src/ui/assets/compat.js'],
    languageOptions: { ecmaVersion: 5, sourceType: 'script' },
    rules: {
      'no-var': 'off',
      'prefer-const': 'off'
    }
  },
  {
    files: ['test/**/*.js', 'tools/**/*.mjs', 'scripts/**/*.mjs'],
    rules: {
      'no-console': 'off'
    }
  }
]
