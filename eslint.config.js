import js from '@eslint/js';

const globals = {
  window: 'readonly', document: 'readonly', localStorage: 'readonly', fetch: 'writable', WebSocket: 'readonly',
  console: 'readonly', process: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
  clearInterval: 'readonly', URL: 'readonly', AbortController: 'readonly', Buffer: 'readonly', navigator: 'readonly',
  URLSearchParams: 'readonly', structuredClone: 'readonly', performance: 'readonly', crypto: 'readonly',
};

export default [
  { ignores: ['dist/**', 'node_modules/**', 'data/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } }, globals },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^(React|_)', caughtErrors: 'none' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
];
