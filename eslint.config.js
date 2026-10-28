import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const noDirectCollections = {
  selector: "CallExpression[callee.property.name='collection']",
  message: 'Reach MongoDB collections only through a repository (TECH-SPEC 5.4).',
};
const noProcessEnv = {
  selector: "MemberExpression[object.name='process'][property.name='env']",
  message: 'Read environment variables only in src/config (TECH-SPEC 2.3).',
};
const noFloatMoney = {
  selector: "CallExpression[callee.name='parseFloat']",
  message: 'Money is bigint minor units; use src/common/money (TECH-SPEC 6.5).',
};

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'openapi.json'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { console: 'readonly', process: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-restricted-syntax': ['error', noDirectCollections, noProcessEnv, noFloatMoney],
    },
  },
  {
    files: ['src/**/*.repository.ts', 'src/common/repository/**', 'src/db/**', 'test/helpers/**'],
    rules: { 'no-restricted-syntax': ['error', noProcessEnv, noFloatMoney] },
  },
  {
    files: ['src/config/**', 'scripts/**', 'vitest.config.ts'],
    rules: { 'no-restricted-syntax': ['error', noDirectCollections, noFloatMoney] },
  },
);
