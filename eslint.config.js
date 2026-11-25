// Lint (AIP-W1 US-7 criterion "green CI (lint, ...)", decision 25/11/2026, Hub row 226).
// Plain English: a spell and grammar checker for code. It flags mistakes such as a misspelt
// variable, a value set but never used, or code that can never run, before a reviewer reads it.
// ESLint's recommended rules, for Node 22 code. A broken sample in CI proves the check works.
import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ["node_modules/**", "lib/gateway/**"] }, // the gateway copy is linted in ai-platform, at its source
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
];
