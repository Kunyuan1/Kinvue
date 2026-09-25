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

/** Enabled for every TypeScript file in the repo, as resolved on 2026-09-25. */
const ENABLED_EVERYWHERE = [
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

/** The `core/` guard, on top of the above (KV-15, KV-129). */
const ENABLED_IN_CORE = ['no-restricted-imports', 'no-restricted-syntax']

const eslint = new ESLint()

/** The rule ids switched on for `filePath`, whatever their options. */
async function enabled(filePath: string): Promise<Set<string>> {
  const config = (await eslint.calculateConfigForFile(filePath)) as {
    rules: Record<string, unknown>
  }
  const on = (setting: unknown): boolean => {
    const severity = Array.isArray(setting) ? setting[0] : setting
    return severity !== 0 && severity !== 'off'
  }
  return new Set(
    Object.entries(config.rules)
      .filter(([, setting]) => on(setting))
      .map(([id]) => id),
  )
}

describe('the enabled lint rule set (KV-134)', () => {
  it.each([
    ['core/', 'core/session/__lint_probe__.ts', [...ENABLED_EVERYWHERE, ...ENABLED_IN_CORE]],
    ['app/main', 'app/main/__lint_probe__.ts', ENABLED_EVERYWHERE],
    ['app/renderer', 'app/renderer/__lint_probe__.tsx', ENABLED_EVERYWHERE],
    ['tests/', 'tests/__lint_probe__.test.ts', ENABLED_EVERYWHERE],
  ])('keeps every rule enabled for %s', async (_where, filePath, expected) => {
    const actual = await enabled(filePath)
    const dropped = expected.filter((id) => !actual.has(id))
    expect(dropped, "enabled before, not now — see this file's docblock").toEqual([])
  }, 30_000)
})
