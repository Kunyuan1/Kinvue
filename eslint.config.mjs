// `@eslint/js` is released independently of `eslint` since v10, so their
// version numbers do not match and should not be made to: asking for
// `@eslint/js` at `eslint`'s version fails to install when that release does
// not exist (KV-134).
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'release/**', 'node_modules/**'] },
  js.configs.recommended,
  // The non-type-aware preset: there is no `projectService`, so no rule that
  // needs type information runs — `no-floating-promises` and
  // `no-misused-promises` among them, which `app/main`'s `void` promises and
  // its "returned rather than swallowed" comments currently hold by hand.
  // Whether to turn them on for `app/main/**` is #135, undecided. Until then
  // this is a known gap, not an oversight. `tests/lint-rules.test.ts` pins
  // which rules this does run (KV-134).
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
      // The base rule, not `@typescript-eslint/no-restricted-imports`, which is
      // deprecated as of typescript-eslint 8.64.0 and slated for removal in v9.
      // The only reason to prefer the plugin version was `allowTypeImports`,
      // which this config does not use — and **must not gain**. `import type`
      // is erased, so the argument for allowing it is that it cannot break the
      // suite; the reason to ban it anyway is above. A React or Electron type
      // in a signature couples core/ just as firmly, and the next value import
      // is then a one-word change with nothing objecting. The base rule already
      // flags type-only imports, verified against each form below.
      'no-restricted-imports': [
        'error',
        {
          // Everything is a pattern rather than a mix of `paths` and
          // `patterns`. An exact `paths` name matches the package and nothing
          // under it, which is how `electron/main` walked past this rule while
          // `@smartspectra/node-sdk/*` — two entries down, written with more
          // care — did not. One entry per thing banned, stated once, so the
          // subpath and the bare name cannot drift apart or carry different
          // reasons (KV-15).
          patterns: [
            {
              // `electron/main`, `electron/common`, `electron/renderer` and
              // `electron/utility` are all real modules the typings declare,
              // and the subpath form is what Electron's own docs push for
              // main-process code in 28+. This repo is on 44.
              group: ['electron', 'electron/*'],
              message:
                'core/ must not import Electron, including its subpaths. Wire it up in ' +
                'app/main instead, and keep the rule here testable without a harness.',
            },
            {
              // Matches on path segments, so this also catches
              // `@testing-library/react` and any future `@scope/react`. That is
              // the right outcome — none of them belong in core/ — so the
              // wording covers them rather than naming React alone.
              group: ['react', 'react-dom', 'react/*', 'react-dom/*'],
              message:
                'core/ must not import React or anything named for it, testing libraries ' +
                'included. It is shared by more than one front end, and the rules here are ' +
                'meant to be tested without rendering anything.',
            },
            {
              group: ['@renderer', '@renderer/*'],
              message:
                'core/ must not reach into the renderer. The dependency runs the other way: ' +
                'app/renderer imports core/, never the reverse.',
            },
            {
              group: ['@smartspectra/node-sdk', '@smartspectra/node-sdk/*'],
              message:
                'core/ must not import the SDK, including its subpaths: the package loads a ' +
                'native runtime through koffi at import time, so importing it here makes the ' +
                'suite need hardware. Reduce the SDK shape in app/main, as ' +
                'app/main/metrics.ts does.',
            },
            {
              // The direction, not another package. Banning the packages left
              // the shortest route to them open: `../../app/main/metrics` is
              // lint-clean and imports the SDK, so a test touching that core
              // module needs hardware without tripping any entry above.
              //
              // It is the likelier accident, not the exotic one. `@core/*` and
              // `@renderer/*` have tsconfig aliases; `app/main` has none, so a
              // relative path is the only spelling available to someone in
              // core/ who wants a type from it.
              group: ['**/app/**', '../app/**', '../../app/**'],
              message:
                'core/ must not import from app/, in any spelling. The dependency runs the ' +
                'other way: app/ imports core/, never the reverse. A relative path into ' +
                'app/main reaches the SDK and makes the suite need hardware.',
            },
          ],
        },
      ],
      // `no-restricted-imports` sees only static forms — `import`, `export
      // from`, side-effect imports. `await import('@smartspectra/node-sdk')`,
      // `require('electron')` and `createRequire(...)('react')` walk past it,
      // and deferring the SDK's load is exactly what someone reading "loads its
      // native runtime at import time" might reach for (KV-129 review). So
      // core/ loads nothing dynamically at all: it has no need to, and a static
      // import is one the rule above can see. Banning the forms outright, rather
      // than listing banned packages a second time, also covers a specifier the
      // rule could never read, like `import(name)`.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message:
            'core/ does not use dynamic import(). Import statically, so the core/ import ' +
            'guard can see what is loaded.',
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            'core/ does not use require(). Import statically, so the core/ import guard ' +
            'can see what is loaded.',
        },
        {
          selector: "CallExpression[callee.name='createRequire']",
          message:
            'core/ does not use createRequire(). Import statically, so the core/ import ' +
            'guard can see what is loaded.',
        },
        {
          selector: 'TSImportEqualsDeclaration',
          message:
            'core/ does not use `import x = require()`. Import statically, so the core/ ' +
            'import guard can see what is loaded.',
        },
      ],
    },
  },
  {
    /**
     * The preload and the renderer never import from `app/main` (review of
     * #187), type-only imports included, for the reason core/'s are banned
     * above: `import type` is erased today, and the next value import is a
     * one-word change that pulls `node:fs`, Electron's main process or the SDK
     * into the sandboxed bridge or the page. A type both sides need lives in
     * `app/shared/`, as `Protection` and `CaptureReply` do.
     * `tests/lint-bridge.test.ts` checks it fires.
     */
    files: ['app/preload/**/*.ts', 'app/renderer/**/*.ts', 'app/renderer/**/*.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // A directory's pattern covers everything under it: `../main`
              // refuses `../main/cipher` too. One per depth the files sit at.
              group: ['../main', '../../main', '../../../main', '**/app/main'],
              message:
                'The preload and the renderer must not import from app/main, types included. ' +
                'Put what both sides need in app/shared/.',
            },
          ],
        },
      ],
    },
  },
  {
    /**
     * The main process answers only Kinvue's own page, and its renderer stays
     * sandboxed (KV-29).
     *
     * Every IPC handler goes through `handle()` in `app/main/index.ts`, which
     * checks the sender before anything runs. It was first held by a text
     * search over that one file, which `ipcMain.handleOnce` and `ipcMain.once`
     * walked past, which any sibling module escaped — and this repo splits main
     * into siblings on purpose — and which a comment saying `sandbox: true`
     * satisfied while the code said otherwise (review of #169). This reads the
     * code, not its characters, across all of `app/main/`.
     *
     * So: no use of `ipcMain` but the one inside `handle()`, which is disabled
     * there with its reason; no way round the name; and the window's security
     * options only as literals, never a value computed at runtime.
     * `tests/lint-main.test.ts` checks every selector still fires.
     */
    files: ['app/main/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='ipcMain']",
          message:
            'app/main registers IPC only through handle() in app/main/index.ts, which ' +
            "answers only Kinvue's own page. ipcMain.handle, handleOnce, on and once all " +
            'skip that check.',
        },
        {
          selector: "MemberExpression[property.name='ipcMain']",
          message:
            'app/main reaches ipcMain only by its own name, so the IPC guard can see every ' +
            'use. Register handlers through handle() in app/main/index.ts.',
        },
        {
          selector: "ImportSpecifier[imported.name='ipcMain'][local.name!='ipcMain']",
          message:
            'app/main does not rename ipcMain on import, so the IPC guard can see every use. ' +
            'Register handlers through handle() in app/main/index.ts.',
        },
        {
          // Electron's checklist item 15 (review of #193): `openExternal` hands
          // its argument to the operating system, which runs whatever is
          // registered for it. One helper holds a fixed list of addresses.
          selector: "MemberExpression[property.name='openExternal']",
          message:
            'app/main opens a link outside the app only through openLink() in ' +
            'app/main/links.ts, which takes a name from its fixed list, never an address ' +
            'from the page (checklist item 15).',
        },
        {
          selector: "ImportSpecifier[imported.name='shell']",
          message:
            'app/main imports shell only in app/main/links.ts, so every link out passes ' +
            'its fixed list (checklist item 15).',
        },
        {
          selector: "Property[key.name='sandbox'][value.value!=true]",
          message:
            'The renderer is sandboxed: sandbox is the literal true, never false or a value ' +
            'computed at runtime (KV-29).',
        },
        {
          selector: "Property[key.name='contextIsolation'][value.value!=true]",
          message:
            'contextIsolation is the literal true, never false or a value computed at ' +
            'runtime (KV-29).',
        },
        {
          selector: "Property[key.name='nodeIntegration'][value.value!=false]",
          message:
            'nodeIntegration is the literal false, never true or a value computed at ' +
            'runtime (KV-29).',
        },
        {
          selector: "Property[key.name='webSecurity'][value.value!=true]",
          message:
            'webSecurity stays on: if it is set at all, it is the literal true (KV-29).',
        },
      ],
    },
  },
)
