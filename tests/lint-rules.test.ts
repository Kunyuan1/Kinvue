import { describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

/**
 * That no lint rule enabled today quietly stops being enabled (KV-134).
 *
 * Almost every rule here comes from `js.configs.recommended` and
 * `tseslint.configs.recommended`, and both lists ship inside the packages the
 * grouped Dependabot PR bumps. A release that drops a rule from `recommended`
 * makes lint quieter and greener with nothing failing — the same blind spot
 * `lint-boundary.test.ts` and `pins.test.ts` exist for. So the set is written
 * down here and checked against the resolved config.
 *
 * **One direction only.** A rule that disappears fails; a rule a bump *adds*
 * passes, since that makes lint stricter, not quieter. When one does fail,
 * read the release notes: if the rule was removed or renamed on purpose, edit
 * the list in the same PR — that edit is the record that someone looked.
 */

/** At error for every TypeScript file in the repo, as resolved on 2026-09-25. */
const ENABLED_FOR_TS = [
  '@typescript-eslint/ban-ts-comment',
  '@typescript-eslint/no-array-constructor',
  '@typescript-eslint/no-duplicate-enum-values',
  '@typescript-eslint/no-empty-object-type',
  '@typescript-eslint/no-explicit-any',
  '@typescript-eslint/no-extra-non-null-assertion',
  '@typescript-eslint/no-misused-new',
  '@typescript-eslint/no-namespace',
  '@typescript-eslint/no-non-null-asserted-optional-chain',
  '@typescript-eslint/no-require-imports',
  '@typescript-eslint/no-this-alias',
  '@typescript-eslint/no-unnecessary-type-constraint',
  '@typescript-eslint/no-unsafe-declaration-merging',
  '@typescript-eslint/no-unsafe-function-type',
  '@typescript-eslint/no-unused-expressions',
  '@typescript-eslint/no-unused-vars',
  '@typescript-eslint/no-wrapper-object-types',
  '@typescript-eslint/prefer-as-const',
  '@typescript-eslint/prefer-namespace-keyword',
  '@typescript-eslint/triple-slash-reference',
  'for-direction',
  'no-async-promise-executor',
  'no-case-declarations',
  'no-compare-neg-zero',
  'no-cond-assign',
  'no-constant-binary-expression',
  'no-constant-condition',
  'no-control-regex',
  'no-debugger',
  'no-delete-var',
  'no-dupe-else-if',
  'no-duplicate-case',
  'no-empty',
  'no-empty-character-class',
  'no-empty-pattern',
  'no-empty-static-block',
  'no-ex-assign',
  'no-extra-boolean-cast',
  'no-fallthrough',
  'no-global-assign',
  'no-invalid-regexp',
  'no-irregular-whitespace',
  'no-loss-of-precision',
  'no-misleading-character-class',
  'no-nonoctal-decimal-escape',
  'no-octal',
  'no-prototype-builtins',
  'no-regex-spaces',
  'no-self-assign',
  'no-shadow-restricted-names',
  'no-sparse-arrays',
  'no-unassigned-vars',
  'no-unexpected-multiline',
  'no-unsafe-finally',
  'no-unsafe-optional-chaining',
  'no-unused-labels',
  'no-unused-private-class-members',
  'no-useless-assignment',
  'no-useless-backreference',
  'no-useless-catch',
  'no-useless-escape',
  'no-var',
  'prefer-const',
  'prefer-rest-params',
  'prefer-spread',
  'preserve-caught-error',
  'require-yield',
  'use-isnan',
  'valid-typeof',
]

/**
 * typescript-eslint turns these off for `.ts`, because tsc already does their
 * job. For a `.js`/`.mjs` file nothing else checks — no tsc — so these are the
 * rules that matter most there, and `eslint.config.mjs` is exactly such a file
 * (KV-134 review: a `@eslint/js` release dropping `no-undef` would leave a
 * typo in the config lint-clean).
 */
const ENABLED_ONLY_FOR_JS = [
  'constructor-super',
  'getter-return',
  'no-class-assign',
  'no-const-assign',
  'no-dupe-args',
  'no-dupe-class-members',
  'no-dupe-keys',
  'no-func-assign',
  'no-import-assign',
  'no-new-native-nonconstructor',
  'no-obj-calls',
  'no-redeclare',
  'no-setter-return',
  'no-this-before-super',
  'no-undef',
  'no-unreachable',
  'no-unsafe-negation',
  'no-with',
]

/** typescript-eslint's `.ts`-only additions, which a `.mjs` file does not get. */
const ENABLED_ONLY_FOR_TS = ['no-var', 'prefer-const', 'prefer-rest-params', 'prefer-spread']

const ENABLED_FOR_JS = [
  ...ENABLED_FOR_TS.filter((id) => !ENABLED_ONLY_FOR_TS.includes(id)),
  ...ENABLED_ONLY_FOR_JS,
]

/** The `core/` guard, on top of the above (KV-15, KV-129). */
const ENABLED_IN_CORE = ['no-restricted-imports', 'no-restricted-syntax']

const eslint = new ESLint()

/**
 * The rule ids set to **error** for `filePath`.
 *
 * Not merely "not off" (KV-134 review): a rule a bump downgrades to `warn`
 * reports and fails nothing, which is the quieter-and-greener regression this
 * file exists for. `npm run lint` runs with `--max-warnings=0` for the same
 * reason, so "enabled" here and "fails CI" there are one statement.
 */
async function enabled(filePath: string): Promise<Set<string>> {
  const config = (await eslint.calculateConfigForFile(filePath)) as
    | { rules: Record<string, unknown> }
    | undefined
  // ESLint answers undefined for a path no config matches; say which.
  if (config === undefined) throw new Error(`no ESLint config applies to ${filePath}`)
  const isError = (setting: unknown): boolean => {
    const severity = Array.isArray(setting) ? setting[0] : setting
    return severity === 2 || severity === 'error'
  }
  return new Set(
    Object.entries(config.rules)
      .filter(([, setting]) => isError(setting))
      .map(([id]) => id),
  )
}

describe('the enabled lint rule set (KV-134)', () => {
  it.each([
    ['core/', 'core/session/__lint_probe__.ts', [...ENABLED_FOR_TS, ...ENABLED_IN_CORE]],
    ['app/main', 'app/main/__lint_probe__.ts', ENABLED_FOR_TS],
    ['app/renderer', 'app/renderer/__lint_probe__.tsx', ENABLED_FOR_TS],
    ['tests/', 'tests/__lint_probe__.test.ts', ENABLED_FOR_TS],
    // The one JavaScript file `eslint .` lints, and the one tsc never sees.
    ['eslint.config.mjs', 'eslint.config.mjs', ENABLED_FOR_JS],
  ])('keeps every rule enabled for %s', async (_where, filePath, expected) => {
    const actual = await enabled(filePath)
    const dropped = expected.filter((id) => !actual.has(id))
    expect(dropped, "enabled before, not now — see this file's docblock").toEqual([])
  }, 30_000)
})

/**
 * Rules whose options carry the enforcement (KV-134 review). An id at error
 * can still enforce nothing if a release flips its default — `ban-ts-comment`
 * allowing a bare `@ts-ignore`, `no-empty` allowing an empty `catch` — or if
 * this repo's own `argsIgnorePattern` is widened. So these are checked the way
 * `lint-boundary.test.ts` checks the import guard: by what they report.
 */
describe('what the option-shaped rules still report (KV-134)', () => {
  /** Rule ids reported at error for `source` in an ordinary app/main file. */
  async function reported(source: string): Promise<string[]> {
    const [result] = await eslint.lintText(source, { filePath: 'app/main/__lint_probe__.ts' })
    if (result === undefined) throw new Error('ESLint returned no result')
    return result.messages.filter((m) => m.severity === 2).map((m) => m.ruleId ?? '(fatal)')
  }

  it('reports a bare @ts-ignore', async () => {
    expect(await reported('// @ts-ignore\nexport const x: number = 1\n')).toContain(
      '@typescript-eslint/ban-ts-comment',
    )
  }, 30_000)

  it('reports an empty catch', async () => {
    expect(
      await reported('export function g(f: () => void): void {\n  try {\n    f()\n  } catch {}\n}\n'),
    ).toContain('no-empty')
  })

  it('reports an unused variable and argument, and not one named with a leading underscore', async () => {
    const unused = '@typescript-eslint/no-unused-vars'
    expect(
      await reported('export function g(unused: number): void {\n  const x = 1\n}\n'),
    ).toEqual([unused, unused])
    expect(
      await reported('export function g(_unused: number): void {\n  const _x = 1\n}\n'),
    ).toEqual([])
  })
})
