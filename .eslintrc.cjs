/** @type {import('eslint').Linter.Config} */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    project: './tsconfig.json',
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:@typescript-eslint/recommended-requiring-type-checking',
  ],
  env: {
    node: true,
    es2022: true,
  },
  ignorePatterns: ['dist/', 'node_modules/', 'src/db/migrations/', 'coverage/'],
  rules: {
    // CLAUDE.md: "Never use `any`" — ESLint errors on it.
    '@typescript-eslint/no-explicit-any': 'error',
    // CLAUDE.md: "never `print()`/console.log — use the logger" (CLI scripts
    // opt out per-line with an explicit eslint-disable comment).
    'no-console': 'error',
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    '@typescript-eslint/no-misused-promises': [
      'error',
      { checksVoidReturn: { arguments: false, attributes: false } },
    ],
  },
  overrides: [
    {
      // Mocking a fluent builder's methods (db.select, redis.incr, ...) via
      // `vi.mocked(obj.method)` is the standard vitest pattern and reads
      // those methods unbound by design — they're vi.fn() stubs, not real
      // class methods that rely on `this`.
      files: ['tests/**/*.ts'],
      rules: {
        '@typescript-eslint/unbound-method': 'off',
      },
    },
  ],
};
