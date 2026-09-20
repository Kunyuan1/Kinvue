import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // tsc already resolves every identifier under `strict`, and it knows the
      // Electron/DOM/node globals per file. Leaving no-undef on would need a
      // hand-maintained globals list that can only drift from what tsc sees.
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    /**
     * core/ stays free of Electron, React and the SDK (KV-15).
     *
     * ARCHITECTURE.md has claimed this since the beginning and said plainly
     * that it was "enforced socially rather than by tooling". The invariant is
     * what lets `npm test` run in a plain node environment with no camera, no
     * API key and no Electron — and a suite needing a window is a suite that
     * stops being run, so the day this breaks is the day the tests start
     * rotting with nothing to announce it.
     *
     * It also stops being tidiness the moment a second app exists: core/ is
     * meant to be imported by the caregiver client and possibly the sync
     * service (#38), neither of which is Electron.
     *
     * Type-only imports are restricted too, deliberately. `import type` is
     * erased and would not break the suite, but a React or Electron type in a
     * signature couples core/ to the framework just as firmly — and the next
     * value import is then a one-word change with nothing objecting.
     */
    files: ['core/**/*.ts', 'core/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'core/ must not import Electron. Wire it up in app/main instead, and keep the ' +
                'rule here testable without a harness.',
            },
            {
              name: '@smartspectra/node-sdk',
              message:
                'core/ must not import the SDK: the package loads a native runtime through ' +
                'koffi at import time, so importing it here makes the suite need hardware. ' +
                'Reduce the SDK shape in app/main, as app/main/metrics.ts does.',
            },
          ],
          patterns: [
            {
              group: ['react', 'react-dom', 'react/*', 'react-dom/*'],
              message:
                'core/ must not import React. It is shared by more than one front end, and ' +
                'the rules here are meant to be tested without rendering anything.',
            },
            {
              group: ['@renderer', '@renderer/*'],
              message:
                'core/ must not reach into the renderer. The dependency runs the other way: ' +
                'app/renderer imports core/, never the reverse.',
            },
            {
              group: ['@smartspectra/node-sdk/*'],
              message:
                'core/ must not import the SDK, including its subpaths. Reduce the SDK shape ' +
                'in app/main, as app/main/metrics.ts does.',
            },
          ],
        },
      ],
    },
  },
)
