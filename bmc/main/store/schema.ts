/**
 * The shape of the module's settings document, and the defensive reader that
 * turns whatever is on disk into it.
 *
 * This document is global to the module rather than tied to the currently
 * connected management station: the BMC addresses it holds are endpoints on
 * the network, not properties of whichever machine happens to be running
 * ipmitool for us. Passwords are necessarily clear text - ModuleContext
 * exposes JSON persistence, but not the host's secret service - which is why
 * every surface that shows this list says so.
 */

export const DEFAULT_IPMI_PORT = 623
export const IPMI_TIMEOUT_MS = 15_000
export const INSPECT_TIMEOUT_MS = 25_000
export const TEST_TIMEOUT_MS = 8_000

/**
 * A ceiling on the list, because every entry costs one ipmitool process per
 * sweep on the connected machine. Sixty-four is well past any rack a person
 * manages from a single pane, and far below the point where a sweep could not
 * finish inside a slow interval.
 */
export const MAX_MACHINES = 64

export interface BmcSettings {
  /** How many BMCs are asked at once during a sweep. */
  sweepConcurrency: number
  /**
   * Read sensors every Nth sweep rather than every sweep; 0 turns sensor
   * folding off entirely and returns the module to power-only health.
   */
  sensorEverySweeps: number
  /** How many of the newest SEL entries a drawer read asks for. */
  selFetchCount: number
  /** What the "Blink UID LED" prompt starts at. */
  identifySeconds: number
}

export const DEFAULT_SETTINGS: Readonly<BmcSettings> = {
  sweepConcurrency: 4,
  sensorEverySweeps: 3,
  selFetchCount: 100,
  identifySeconds: 15
}

/** Ranges the UI states and `normalize` enforces, so a hand-edited file cannot wedge a sweep. */
export const SETTING_LIMITS: Readonly<Record<keyof BmcSettings, { min: number; max: number }>> = {
  sweepConcurrency: { min: 1, max: 16 },
  sensorEverySweeps: { min: 0, max: 20 },
  selFetchCount: { min: 10, max: 1000 },
  identifySeconds: { min: 0, max: 255 }
}

export interface BmcMachine {
  id: string
  /** Opaque non-secret token changed on every edit and safe to send to the UI. */
  revision: string
  name: string
  ip: string
  port: number
  username: string
  /**
   * Only ever present in a document written before version 3, and only until
   * the first sweep moves it. Passwords live in the app's encrypted secret
   * store now (see `credentials.ts`); this field exists so a document written
   * by an older version of this module can still be read, and is deleted from
   * the document the moment its value is safely stored.
   *
   * Nothing but the migration should read it.
   */
  password?: string
  /**
   * False parks the entry: it keeps its credentials and its row, and the
   * sweep stops asking it anything. Deleting is not the same thing - a
   * machine that is off for a fortnight should not have to be typed in again.
   */
  enabled: boolean
  note?: string
}

export interface BmcConfig {
  /** 3 once passwords have moved to the secret store; 2 while any remain. */
  version: 2 | 3
  machines: BmcMachine[]
  settings: BmcSettings
  /** Whether the explanatory panels on this module's pages are shown. */
  hintsOn: boolean
}

/**
 * Stable comparison for check tokens and in-flight network results.
 *
 * `enabled` is part of it deliberately: parking a machine has to invalidate a
 * reading that was already in flight, or the card keeps the answer it got
 * from an endpoint the user has just said to stop touching.
 */
export function machineFingerprint(machine: BmcMachine): string {
  return JSON.stringify([
    machine.id,
    machine.revision,
    machine.name,
    machine.ip,
    machine.port,
    machine.username,
    machine.enabled,
    machine.note ?? ''
  ])
}

export function defaultSettings(): BmcSettings {
  return { ...DEFAULT_SETTINGS }
}

export function emptyConfig(): BmcConfig {
  return { version: 3, machines: [], settings: defaultSettings(), hintsOn: true }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_IPMI_PORT
}

/** Round and clamp one tunable; anything unreadable falls back to its default. */
export function clampSetting(key: keyof BmcSettings, value: unknown): number {
  const limits = SETTING_LIMITS[key]
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS[key]
  return Math.max(limits.min, Math.min(limits.max, Math.trunc(parsed)))
}

function normalizeSettings(raw: unknown): BmcSettings {
  const source = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  return {
    sweepConcurrency: clampSetting('sweepConcurrency', source.sweepConcurrency),
    sensorEverySweeps: clampSetting('sensorEverySweeps', source.sensorEverySweeps),
    selFetchCount: clampSetting('selFetchCount', source.selFetchCount),
    identifySeconds: clampSetting('identifySeconds', source.identifySeconds)
  }
}

/** A short id that remains readable in the JSON settings document. */
export function makeMachineId(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = `m${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`
    if (!taken.has(id)) return id
  }
  return `m${Date.now().toString(36)}-${taken.size.toString(36).padStart(4, '0').slice(-4)}`
}

export function makeMachineRevision(): string {
  return `r${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/**
 * Read defensively because users may edit the file by hand and older module
 * versions wrote a different shape.
 *
 * Version 1 documents (no `enabled`, no `settings`, no `hintsOn`) are read as
 * if every machine were enabled and every tunable were its default, which is
 * exactly what version 1 did. Nothing is written back here: the upgrade lands
 * the first time something calls `update()`, so merely opening the page on a
 * new module version does not rewrite a file the previous one can still read.
 */
export function normalize(raw: unknown): BmcConfig {
  if (typeof raw !== 'object' || raw === null) return emptyConfig()
  const source = raw as Partial<BmcConfig> & { hintsOn?: unknown }
  const machines: BmcMachine[] = []
  const ids = new Set<string>()
  const entries = Array.isArray(source.machines) ? source.machines : []

  for (const [position, entry] of entries.entries()) {
    if (machines.length >= MAX_MACHINES) break
    if (typeof entry !== 'object' || entry === null) continue
    const candidate = entry as Partial<BmcMachine>
    const ip = asString(candidate.ip).trim()
    const username = asString(candidate.username).trim()
    if (!ip || !username) continue

    let id = asString(candidate.id).trim()
    if (!id || ids.has(id)) {
      const base = `mlegacy-${position.toString(36)}`
      id = base
      let suffix = 1
      while (ids.has(id)) {
        suffix += 1
        id = `${base}-${suffix}`
      }
    }
    ids.add(id)

    const name = asString(candidate.name).trim()
    const note = asString(candidate.note).trim()
    const legacyPassword = asString(candidate.password)
    machines.push({
      id,
      revision: asString(candidate.revision).trim() || `legacy-${id}`,
      name: name || ip,
      ip,
      port: asPort(candidate.port),
      username,
      // Carried through only so the migration can find it. A document already
      // at version 3 has none, and the field is dropped the moment the value
      // reaches the secret store.
      ...(legacyPassword ? { password: legacyPassword } : {}),
      // Absent means a version 1 document, where every machine was swept.
      enabled: candidate.enabled !== false,
      note: note || undefined
    })
  }

  return {
    // Only a document with nothing left to move is called version 3, so the
    // number says what is true of it rather than which module version wrote it.
    version: machines.some((machine) => machine.password) ? 2 : 3,
    machines,
    settings: normalizeSettings(source.settings),
    hintsOn: source.hintsOn !== false
  }
}

/** How many entries a document on disk had before `MAX_MACHINES` was applied. */
export function droppedMachineCount(raw: unknown): number {
  if (typeof raw !== 'object' || raw === null) return 0
  const entries = (raw as Partial<BmcConfig>).machines
  if (!Array.isArray(entries)) return 0
  const usable = entries.filter((entry) => {
    if (typeof entry !== 'object' || entry === null) return false
    const candidate = entry as Partial<BmcMachine>
    return Boolean(asString(candidate.ip).trim() && asString(candidate.username).trim())
  }).length
  return Math.max(0, usable - MAX_MACHINES)
}

/** `10.0.0.5`, or `10.0.0.5:664` when the port is not the standard one. */
export function machineAddress(machine: Pick<BmcMachine, 'ip' | 'port'>): string {
  return machine.port === DEFAULT_IPMI_PORT ? machine.ip : `${machine.ip}:${machine.port}`
}
