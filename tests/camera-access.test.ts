import { describe, expect, it } from 'vitest'
import { cameraAccess, SWITCHES, valueFrom, type ReadSwitch } from '../app/main/camera-access'

/**
 * Whether Windows lets Kinvue use the camera (KV-19), said before a capture
 * rather than after one fails. The three switches are stood in for; the real
 * reader is `reg.exe`, whose output `valueFrom` parses.
 */

const [computer, apps, desktop] = SWITCHES.map((s) => s.key) as [string, string, string]

const switches =
  (values: Record<string, string | null>): ReadSwitch =>
  async (key) =>
    values[key] ?? null

describe('cameraAccess', () => {
  it('is allowed when every switch allows it, or was never set', async () => {
    expect(await cameraAccess(switches({ [computer]: 'Allow', [apps]: 'Allow', [desktop]: 'Allow' }))).toBe(
      'allowed',
    )
    expect(await cameraAccess(switches({}))).toBe('allowed')
  })

  it('names the switch that is off, the widest first', async () => {
    expect(await cameraAccess(switches({ [desktop]: 'Deny' }))).toBe('off-for-desktop-apps')
    expect(await cameraAccess(switches({ [apps]: 'Deny', [desktop]: 'Deny' }))).toBe('off-for-apps')
    expect(await cameraAccess(switches({ [computer]: 'Deny', [desktop]: 'Deny' }))).toBe(
      'off-for-this-computer',
    )
  })

  it('says nothing, rather than guessing, when the switches cannot be read', async () => {
    expect(
      await cameraAccess(async () => {
        throw new Error('reg.exe not found')
      }),
    ).toBe('unknown')
  })

  it('reads the desktop-apps switch, which is the one that holds Kinvue', () => {
    expect(desktop).toMatch(/\\ConsentStore\\webcam\\NonPackaged$/)
    expect(computer).toMatch(/^HKLM\\/)
    expect(apps).toMatch(/^HKCU\\.*\\webcam$/)
  })
})

describe('valueFrom', () => {
  it("reads the value as reg.exe prints it, and nothing from what holds none", () => {
    const printed =
      '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager' +
      '\\ConsentStore\\webcam\\NonPackaged\r\n    Value    REG_SZ    Deny\r\n\r\n'
    expect(valueFrom(printed)).toBe('Deny')
    expect(valueFrom(printed.replace('Deny', 'Allow'))).toBe('Allow')
    expect(valueFrom('\r\nHKEY_CURRENT_USER\\Software\\X\r\n\r\n')).toBeNull()
    expect(valueFrom('')).toBeNull()
  })
})
