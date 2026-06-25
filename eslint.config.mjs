import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      // Generated theme-extension bundle (built by extensions/theme/build.mjs from src/).
      'extensions/*/assets/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      // CLAUDE.md: no `any` without an inline justification.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Node scripts and ESM/CJS config files run on Node and use its globals. (typescript-eslint
    // already disables no-undef for .ts; this covers the plain .mjs/.cjs/.js files.)
    files: ['**/*.{mjs,cjs}', '**/scripts/**/*.{js,mjs}'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
      },
    },
  },
);
