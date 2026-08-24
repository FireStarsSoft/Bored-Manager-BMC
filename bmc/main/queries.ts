import type { ModuleContext } from '@shared/modules'
import {
  INSPECT_TIMEOUT_MS,
  machineFingerprint,
  type BmcMachine,
  type ConfigStore
} from './config'
import { runIpmi, runIpmiInspect } from './ipmi'
import {
  parseInspect,
  parseSdr,
  parseSel,
  type SelRow,
  type SensorRow
} from './parse'

export interface MachineInspect {
  name: string
  ip: string
  firmware: string
  ipmiVersion: string
  manufacturer: string
  product: string
  serial: string
  mac: string
  problem: string
}

class TtlCache<T> {
  private values = new Map<string, { expiresAt: number; value: T }>()
  private flights = new Map<string, Promise<T>>()
  private generation = 0

  constructor(
    private ttlMs: number,
    private shouldCache: (value: T) => boolean = () => true
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const cached = this.values.get(key)
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value)
    const existing = this.flights.get(key)
    if (existing) return existing

    const generation = this.generation
    const pending = load()
      .then((value) => {
        if (generation === this.generation && this.shouldCache(value)) {
          this.values.set(key, { expiresAt: Date.now() + this.ttlMs, value })
        }
        return value
      })
      .finally(() => {
        if (this.flights.get(key) === pending) this.flights.delete(key)
      })
    this.flights.set(key, pending)
    return pending
  }

  clear(key?: string): void {
    this.generation += 1
    if (key == null) {
      this.values.clear()
      this.flights.clear()
      return
    }
    this.values.delete(key)
    this.flights.delete(key)
  }

  clearPrefix(prefix: string): void {
    this.generation += 1
    for (const key of this.values.keys()) {
      if (key.startsWith(prefix)) this.values.delete(key)
    }
    for (const key of this.flights.keys()) {
      if (key.startsWith(prefix)) this.flights.delete(key)
    }
  }
}

function missingInspect(id: string): MachineInspect {
  return {
    name: '',
    ip: '',
    firmware: '',
    ipmiVersion: '',
    manufacturer: '',
    product: '',
    serial: '',
    mac: '',
    problem: id ? 'No such BMC machine.' : 'No machine was selected.'
  }
}

export class Queries {
  private inspectCache = new TtlCache<MachineInspect>(
    10 * 60 * 1000,
    (value) => value.problem === ''
  )
  private sensorCache = new TtlCache<SensorRow[]>(5 * 1000)
  private selCache = new TtlCache<SelRow[]>(30 * 1000)

  constructor(
    private ctx: ModuleContext,
    private config: ConfigStore
  ) {}

  machineInspect(idRaw: unknown, revisionRaw: unknown): Promise<MachineInspect> {
    const id = String(idRaw ?? '')
    const machine = this.findMachine(id, String(revisionRaw ?? ''))
    if (!machine) return Promise.resolve(missingInspect(id))
    const key = this.cacheKey(machine)

    return this.inspectCache.get(key, async () => {
      const result = await runIpmiInspect(this.ctx, machine, INSPECT_TIMEOUT_MS)
      if (!result.ok) {
        return {
          ...missingInspect(''),
          name: machine.name,
          ip: machine.ip,
          problem: result.message ?? 'Could not inspect this BMC.'
        }
      }
      const facts = parseInspect(result.stdout)
      return { name: machine.name, ip: machine.ip, ...facts, problem: '' }
    })
  }

  sensorRows(idRaw: unknown, revisionRaw: unknown): Promise<SensorRow[]> {
    const id = String(idRaw ?? '')
    const machine = this.findMachine(id, String(revisionRaw ?? ''))
    if (!machine) return Promise.resolve([])
    return this.sensorCache.get(this.cacheKey(machine), async () => {
      const result = await runIpmi(this.ctx, machine, 'sdr elist')
      return result.ok ? parseSdr(result.stdout) : []
    })
  }

  selRows(idRaw: unknown, revisionRaw: unknown): Promise<SelRow[]> {
    const id = String(idRaw ?? '')
    const machine = this.findMachine(id, String(revisionRaw ?? ''))
    if (!machine) return Promise.resolve([])
    return this.selCache.get(this.cacheKey(machine), async () => {
      const result = await runIpmi(this.ctx, machine, 'sel elist last 100')
      return result.ok ? parseSel(result.stdout) : []
    })
  }

  clearSel(id: string): void {
    this.selCache.clearPrefix(`${id}\0`)
  }

  clearMachine(id: string): void {
    const prefix = `${id}\0`
    this.inspectCache.clearPrefix(prefix)
    this.sensorCache.clearPrefix(prefix)
    this.selCache.clearPrefix(prefix)
  }

  reset(): void {
    this.inspectCache.clear()
    this.sensorCache.clear()
    this.selCache.clear()
  }

  private cacheKey(machine: BmcMachine): string {
    return `${machine.id}\0${machineFingerprint(machine)}`
  }

  private findMachine(id: string, revision: string): BmcMachine | undefined {
    return this.config
      .read()
      .machines.find((machine) => machine.id === id && machine.revision === revision)
  }
}
