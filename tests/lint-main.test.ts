import { beforeAll, describe, expect, it } from 'vitest'
import { ESLint } from 'eslint'

/**
 * That the main-process guard still fires (KV-29).
 *
 * Every IPC handler goes through `handle()` in `app/main/index.ts`, which
 * answers only Kinvue's own page, and the window's security options are
 * literals. `eslint.config.mjs` holds both, as `no-restricted-syntax`
 * selectors over `app/main/**`. It replaced a text search over one file that
 * `ipcMain.handleOnce` and `ipcMain.once` walked past, that any sibling module
 * escaped, and that a comment could satisfy (review of #169) — so the cases it
 * missed are among the probes here.
 *
 * Built like `tests/lint-boundary.test.ts`: linted as text at paths that do not
 * exist, refusing to call an unlinted file clean, and tied to the config — the
 * last test fails if a selector is added with no probe.
 */

const eslint = new ESLint()
const SYNTAX = 'no-restricted-syntax'

/** What the guard reported for `source` linted as `filePath`; throws if it was never linted. */
async function guard(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath })
  if (result === undefined) throw new Error(`ESLint returned no result for ${filePath}`)
  const unlinted = result.messages.filter((m) => m.fatal === true || m.ruleId === null)
  if (unlinted.length > 0) {
    throw new Error(`${filePath} was not linted: ${unlinted.map((m) => m.message).join('; ')}`)
  }
  return result.messages.filter((m) => m.ruleId === SYNTAX).map((m) => m.message)
}

/** A sibling module, the likely place for the next handler (a Phase 5 `remote.ts`). */
const IN_MAIN = 'app/main/__lint_probe__.ts'
const OUTSIDE_MAIN = 'app/renderer/__lint_probe__.ts'

type Probe = [what: string, source: string, says: string]

const IPC = 'registers IPC only through handle()'
const IPC_NAME = 'reaches ipcMain only by its own name'
const IPC_RENAME = 'does not rename ipcMain'
const SANDBOX = 'sandbox is the literal true'
const ISOLATION = 'contextIsolation is the literal true'
const NODE = 'nodeIntegration is the literal false'
const WEB = 'webSecurity stays on'
const LINK = 'opens a link outside the app only through openLink()'
const SHELL = 'imports shell only in app/main/links.ts'

const IMPORT = "import { ipcMain } from 'electron'\n"

const PROBES: Probe[] = [
  ['ipcMain.handle, registered directly', `${IMPORT}ipcMain.handle('x', () => 1)`, IPC],
  ['ipcMain.handleOnce, which the text search missed', `${IMPORT}ipcMain.handleOnce('key:read', () => 1)`, IPC],
  ['ipcMain.once, which the text search missed', `${IMPORT}ipcMain.once('x', () => undefined)`, IPC],
  ['ipcMain.on', `${IMPORT}ipcMain.on('x', () => undefined)`, IPC],
  ['ipcMain.addListener', `${IMPORT}ipcMain.addListener('x', () => undefined)`, IPC],
  [
    'ipcMain reached through the electron namespace',
    "import * as electron from 'electron'\nelectron.ipcMain.handle('x', () => 1)",
    IPC_NAME,
  ],
  [
    'ipcMain renamed on import',
    "import { ipcMain as bus } from 'electron'\nbus.handle('x', () => 1)",
    IPC_RENAME,
  ],
  ['sandbox: false', 'export const w = { sandbox: false }', SANDBOX],
  [
    'sandbox computed at runtime, which a comment could have hidden',
    "// sandbox: true\nexport const w = { sandbox: process.env.KINVUE_NO_SANDBOX !== '1' }",
    SANDBOX,
  ],
  ['contextIsolation: false', 'export const w = { contextIsolation: false }', ISOLATION],
  ['nodeIntegration: true', 'export const w = { nodeIntegration: true }', NODE],
  ['webSecurity: false', 'export const w = { webSecurity: false }', WEB],
  [
    'shell.openExternal with an address from anywhere',
    "import * as electron from 'electron'\nexport const open = (url: string) => electron.shell.openExternal(url)",
    LINK,
  ],
  ['shell imported, to open links past the list', "import { shell } from 'electron'\nexport { shell }", SHELL],
]

/** What app/main may do: the options as literals, a call to the checked wrapper, prose. */
const ALLOWED: [string][] = [
  ['export const w = { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true }'],
  ["declare function handle(c: string, f: () => unknown): void\nhandle('sessions:list', () => [])"],
  ["declare function openLink(l: 'cameraSettings'): Promise<void>\nvoid openLink('cameraSettings')"],
  ['// Registered with ipcMain.handle( inside handle(); sandbox: false is never allowed.\nexport {}'],
]

beforeAll(async () => {
  // Config resolution happens on the first lint; taken here so it cannot push
  // a test past Vitest's default timeout (as in lint-boundary.test.ts).
  await guard('export {}', IN_MAIN)
}, 30_000)

describe('the main-process guard (KV-29)', () => {
  it.each(PROBES)('reports %s', async (_what, source, says) => {
    const reports = await guard(source, IN_MAIN)
    expect(reports.some((m) => m.includes(says)), reports.join(' | ')).toBe(true)
  })

  it('covers every file in app/main, not one', async () => {
    const reports = await guard(`${IMPORT}ipcMain.handle('remote:pair', () => 1)`, 'app/main/remote/pair.ts')
    expect(reports.join()).toContain(IPC)
  })

  it.each(PROBES)('does not report %s outside app/main', async (_what, source) => {
    // Otherwise a rule that fired on every file would pass the tests above.
    expect(await guard(source, OUTSIDE_MAIN)).toEqual([])
  })

  it.each(ALLOWED)('does not report %s inside app/main', async (source) => {
    expect(await guard(source, IN_MAIN)).toEqual([])
  })

  it('refuses to call a file clean when it was never linted', async () => {
    await expect(guard(`${IMPORT}ipcMain.on('x', () => undefined`, IN_MAIN)).rejects.toThrow(/was not linted/)
  })

  it('has a probe for every selector the config holds for app/main', async () => {
    const config = (await eslint.calculateConfigForFile(IN_MAIN)) as {
      rules: Record<string, [unknown, ...unknown[]]>
    }
    const [, ...selectors] = config.rules[SYNTAX] ?? []
    const configured = (selectors as { message: string }[]).map((s) => s.message)
    // A shape this cannot read is a loud failure, not an empty list that passes.
    expect(configured.length, `${SYNTAX} selectors`).toBeGreaterThan(0)
    const unprobed = configured.filter((message) => !PROBES.some(([, , says]) => message.includes(says)))
    expect(unprobed, 'configured with no probe in this file').toEqual([])
  })
})
