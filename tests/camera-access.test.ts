import { describe, expect, it } from 'vitest'
import {
  appSwitch,
  cameraAccess,
  SWITCHES,
  valueFrom,
  type ReadSwitch,
} from '../app/main/camera-access'

/**
 * Whether Windows lets Kinvue use the camera (KV-19), said before a capture
 * rather than after one fails. The three switches are stood in for; the real
 * reader is `reg.exe`, whose output `valueFrom` parses.
 */

const [computer, apps, desktop] = SWITCHES.map((s) => s.key) as [string, string, string]
const EXE = String.raw`C:\Users\Zoë\AppData\Local\Programs\Kinvue\Kinvue.exe`
const kinvue = appSwitch(EXE)

const switches =
  (values: Record<string, string | null>): ReadSwitch =>
  async (key) =>
    values[key] ?? null

describe('cameraAccess', () => {
  it('is allowed when every switch allows it, or was never set', async () => {
    const allAllow = switches({ [computer]: 'Allow', [apps]: 'Allow', [desktop]: 'Allow' })
    expect(await cameraAccess(allAllow, EXE)).toBe('allowed')
    expect(await cameraAccess(switches({}), EXE)).toBe('allowed')
  })

  it('names the switch that is off, the widest first', async () => {
    expect(await cameraAccess(switches({ [desktop]: 'Deny' }), EXE)).toBe('off-for-desktop-apps')
    expect(await cameraAccess(switches({ [apps]: 'Deny', [desktop]: 'Deny' }), EXE)).toBe(
      'off-for-apps',
    )
    expect(await cameraAccess(switches({ [computer]: 'Deny', [desktop]: 'Deny' }), EXE)).toBe(
      'off-for-this-computer',
    )
  })

  it('says nothing, rather than guessing, when the switches cannot be read', async () => {
    expect(
      await cameraAccess(async () => {
        throw new Error('reg.exe not found')
      }, EXE),
    ).toBe('unknown')
  })

  it('reads the desktop-apps switch, which is the one that holds Kinvue', () => {
    expect(desktop).toMatch(/\\ConsentStore\\webcam\\NonPackaged$/)
    expect(computer).toMatch(/^HKLM\\/)
    expect(apps).toMatch(/^HKCU\\.*\\webcam$/)
  })
})

describe("Kinvue's own value (review of #193)", () => {
  it('is read where Windows writes it, the path with # for each backslash', () => {
    expect(kinvue).toBe(
      desktop + String.raw`\C:#Users#Zoë#AppData#Local#Programs#Kinvue#Kinvue.exe`,
    )
  })

  it('is said when it denies, after every switch in Settings allows', async () => {
    expect(await cameraAccess(switches({ [kinvue]: 'Deny' }), EXE)).toBe('off-for-kinvue')
    // A switch in Settings that is off is named first: it is the one to change.
    expect(await cameraAccess(switches({ [kinvue]: 'Deny', [desktop]: 'Deny' }), EXE)).toBe(
      'off-for-desktop-apps',
    )
    // Usually it holds only when the camera was last used, and no value at all.
    expect(await cameraAccess(switches({ [kinvue]: null }), EXE)).toBe('allowed')
  })
})

describe('valueFrom', () => {
  it("reads the value as reg.exe prints it, and nothing from what holds none", () => {
    const printed =
      '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion' +
      '\\CapabilityAccessManager\\ConsentStore\\webcam\\NonPackaged' +
      '\r\n    Value    REG_SZ    Deny\r\n\r\n'
    expect(valueFrom(printed)).toBe('Deny')
    expect(valueFrom(printed.replace('Deny', 'Allow'))).toBe('Allow')
    expect(valueFrom('\r\nHKEY_CURRENT_USER\\Software\\X\r\n\r\n')).toBeNull()
    expect(valueFrom('')).toBeNull()
  })
})
