/**
 * User-maintained BMC endpoints and credentials.
 *
 * This document is global to the module rather than tied to the currently
 * connected management station. Passwords are necessarily clear text:
 * ModuleContext exposes JSON persistence, but not the host's secret service.
 */
import type { ModuleContext } from '@shared/modules'

export const DEFAULT_IPMI_PORT = 623
export const IPMI_TIMEOUT_MS = 15_000
export const INSPECT_TIMEOUT_MS = 25_000
export const SWEEP_CONCURRENCY = 4

export interface BmcMachine {
  id: string
  /** Opaque non-secret token changed on every edit and safe to send to the UI. */
  revision: string
  name: string
  ip: string
  port: number
  username: string
  /** Clear text. Never return this field to the renderer. */
  password: string
  note?: string
}

export interface BmcConfig {
  version: 1
  machines: BmcMachine[]
}

/** Stable comparison for check tokens and in-flight network results. */
export function machineFingerprint(machine: BmcMachine): string {
  return JSON.stringify([
    machine.id,
    machine.revision,
    machine.name,
    machine.ip,
    machine.port,
    machine.username,
    machine.password,
    machine.note ?? ''
  ])
}

function emptyConfig(): BmcConfig {
  return { version: 1, machines: [] }
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asPort(value: unknown): number {
  const port = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : DEFAULT_IPMI_PORT
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
 * versions may have written a different shape.
 */
function normalize(raw: unknown): BmcConfig {
  if (typeof raw !== 'object' || raw === null) return emptyConfig()
  const source = raw as Partial<BmcConfig>
  const machines: BmcMachine[] = []
  const ids = new Set<string>()
  const entries = Array.isArray(source.machines) ? source.machines : []

  for (const [position, entry] of entries.entries()) {
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
    machines.push({
      id,
      revision: asString(candidate.revision).trim() || `legacy-${id}`,
      name: name || ip,
      ip,
      port: asPort(candidate.port),
      username,
      password: asString(candidate.password),
      note: note || undefined
    })
  }

  return { version: 1, machines }
}

/**
 * Config is shared by every connected-machine instance of this module. Read it
 * afresh so an edit made while viewing one management station is immediately
 * visible to the others and cannot be overwritten from a stale cache.
 */
export class ConfigStore {
  constructor(private ctx: ModuleContext) {}

  read(): BmcConfig {
    return normalize(this.ctx.configGet())
  }

  update<T>(mutate: (config: BmcConfig) => T): T {
    const config = this.read()
    const result = mutate(config)
    this.ctx.configSet(config)
    return result
  }

  reset(): void {
    // No in-memory document to invalidate.
  }
}
