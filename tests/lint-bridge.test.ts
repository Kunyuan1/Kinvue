import { beforeAll, describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

/**
 * That the preload and the renderer cannot import from `app/main` (review of
 * #187), type-only imports included: the next value import would pull
 * `node:fs`, Electron's main process or the SDK into the sandboxed bridge or
 * the page. Linted as text at paths that do not exist, like
 * `tests/lint-main.test.ts`, refusing to call an unlinted file clean.
 */

const eslint = new ESLint()
const RULE = 'no-restricted-imports'

/** What the rule reported for `source` linted as `filePath`; throws if it was never linted. */
async function reported(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath })
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`)
  const unlinted = result.messages.filter((m) => m.fatal === true || m.ruleId === null)
  if (unlinted.length > 0) {
    throw new Error(`${filePath} was not linted: ${unlinted.map((m) => m.message).join('; ')}`)
  }
  return result.messages.filter((m) => m.ruleId === RULE).map((m) => m.message)
}

const SAYS = 'must not import from app/main'

beforeAll(async () => {
  // ESLint resolves the config on the first lint, not in its constructor, and
  // that load is most of this file's time. Taken here, under its own timeout,
  // as `lint-boundary.test.ts` does, so it cannot push whichever case runs
  // first past Vitest's 5 s default and read as the guard breaking (review of
  // #187: it did, once).
  await reported('', 'app/preload/__probe__.ts')
}, 30_000)

describe('the bridge and the page import nothing from app/main', () => {
  const refused: [where: string, source: string][] = [
    ['app/preload/__probe__.ts', "import type { Protection } from '../main/cipher'\n"],
    ['app/preload/__probe__.ts', "import { osCipher } from '../main/cipher'\n"],
    ['app/renderer/__probe__.ts', "import type { X } from '../main/index'\n"],
    ['app/renderer/components/__probe__.tsx', "import { y } from '../../main/vitals'\n"],
  ]
  for (const [where, source] of refused) {
    it(`refuses ${source.trim()} in ${where}`, async () => {
      const messages = await reported(source, where)
      expect(messages.some((m) => m.includes(SAYS))).toBe(true)
    })
  }

  it('allows app/shared, from either side', async () => {
    expect(
      await reported(
        "import type { Protection } from '../shared/protection'\n",
        'app/preload/__probe__.ts',
      ),
    ).toEqual([])
    expect(
      await reported(
        "import type { Protection } from '../../shared/protection'\n",
        'app/renderer/components/__probe__.tsx',
      ),
    ).toEqual([])
  })
})
