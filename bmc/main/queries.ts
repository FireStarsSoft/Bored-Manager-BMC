/**
 * The reads a drawer asks for: inspection facts, the sensor table, the event
 * log. All three are network round trips to a slow controller, so each is
 * cached briefly and de-duplicated while in flight.
 *
 * Every one of them answers with a result object rather than a bare array.
 * Returning `[]` on failure - which is what this did before - makes "this BMC
 * has no event log entries" and "this BMC did not answer" the same picture,
 * and the second is the one somebody needs to know about.
 */
import type { ModuleContext } from '@shared/modules'
import type { ValueBadge } from '@shared/module-ui'
import { statusBadges } from './badges'
import { CLOCK_DRIFT_WARN_SECONDS, type ClockDrift } from './sweep'
import {
  headroom,
  parseInspect,
  parseSdr,
  parseSel,
  parseSensorThresholds,
  type SensorThresholds,
  resultProblem,
  runIpmi,
  runIpmiInspect,
  type SelRow,
  type SensorRow
} from './ipmi'
import {
  INSPECT_TIMEOUT_MS,
  machineFingerprint,
  type BmcMachine,
  type ConfigStore,
  type Credentials
} from './store'

export interface MachineInspect {
  name: string
  ip: string
  firmware: string
  ipmiVersion: string
  manufacturer: string
  product: string
  serial: string
  mac: string
  /**
   * Null when there is nothing wrong. A `conditional` block's `exists` test is
   * `value != null`, so an empty string here would render an empty problem
   * panel on every healthy machine.
   */
  problem: string | null
}

/** A sensor row as the table sees it: the parsed row plus its coloured chip. */
export interface SensorTableRow extends SensorRow {
  statusBadges: ValueBadge[]
  /**
   * The nearest threshold on either side, and how far the reading is from it.
   *
   * Both null unless the controller was configured with one, which is the
   * ordinary case for a voltage and the usual case for a temperature. The
   * status word already says whether a reading is inside its thresholds; this
   * is what turns "ok" into "ok, and eight degrees from not being".
   */
  limit: number | null
  headroom: number | null
}

export interface SensorResult {
  t: number
  rows: SensorTableRow[]
  problem: string | null
}

export interface SelResult {
  t: number
  rows: SelRow[]
  problem: string | null
  /**
   * Set when the controller's own clock is far enough out that the times below
   * cannot be lined up against anything else. Null when it is fine, so a
   * `conditional`'s `exists` shows the warning only when there is one.
   */
  clockWarning: string | null
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

function missingInspect(problem: string | null): MachineInspect {
  return {
    name: '',
    ip: '',
    firmware: '',
    ipmiVersion: '',
    manufacturer: '',
    product: '',
    serial: '',
    mac: '',
    problem
  }
}

const NO_MACHINE = 'That BMC entry is gone or was changed - close this drawer and open the row again.'

/**
 * What a wrong controller clock means for the log underneath it.
 *
 * Null when there is nothing to say. The times in an event log come from the
 * controller, so a clock that is hours out does not make the log wrong - it
 * makes it impossible to line up against anything else, which is worse,
 * because it looks fine.
 */
function describeDrift(drift: ClockDrift | null): string | null {
  if (!drift) return null
  if (drift.seconds == null) {
    return 'This BMC has no clock set, so the times below are whatever it counted from when it last started - not times of day.'
  }
  if (Math.abs(drift.seconds) <= CLOCK_DRIFT_WARN_SECONDS) return null
  const minutes = Math.round(Math.abs(drift.seconds) / 60)
  const amount = minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`
  return `This BMC's clock is about ${amount} ${drift.seconds > 0 ? 'ahead of' : 'behind'} this machine's, so the times below will not line up with anything else you are reading.`
}

/** The threshold the headroom above was measured against. */
function nearestLimit(value: number, thresholds: SensorThresholds): number | null {
  const above = [thresholds.unc, thresholds.ucr, thresholds.unr]
    .filter((limit): limit is number => limit != null && limit > value)
    .sort((a, b) => a - b)[0]
  const below = [thresholds.lnc, thresholds.lcr, thresholds.lnr]
    .filter((limit): limit is number => limit != null && limit < value)
    .sort((a, b) => b - a)[0]
  if (above == null) return below ?? null
  if (below == null) return above
  return above - value <= value - below ? above : below
}

export class Queries {
  private inspectCache = new TtlCache<MachineInspect>(
    10 * 60 * 1000,
    (value) => value.problem === null
  )
  // A failed read is never cached, so the next poll retries instead of
  // repeating an error for the whole TTL.
  private sensorCache = new TtlCache<SensorResult>(5 * 1000, (value) => value.problem === null)
  private selCache = new TtlCache<SelResult>(30 * 1000, (value) => value.problem === null)

  constructor(
    private ctx: ModuleContext,
    private config: ConfigStore,
    private credentials: Credentials,
    /**
     * What the sweep last found out about this machine's clock. A callback
     * rather than a reference to the sweeper: the event log is a read, and it
     * has no business knowing how sweeping works.
     */
    private clockFor: (id: string, revision: string) => ClockDrift | null = () => null
  ) {}

  machineInspect(idRaw: unknown, revisionRaw: unknown): Promise<MachineInspect> {
    const machine = this.findMachine(idRaw, revisionRaw)
    if (!machine) return Promise.resolve(missingInspect(NO_MACHINE))
    const key = this.cacheKey(machine)

    return this.inspectCache.get(key, async () => {
      const credential = await this.credentials.read(machine)
      if (!credential.password) {
        return { ...missingInspect(credential.problem), name: machine.name, ip: machine.ip }
      }
      const result = await runIpmiInspect(
        this.ctx,
        machine,
        credential.password,
        INSPECT_TIMEOUT_MS
      )
      if (!result.ok) {
        return {
          ...missingInspect(resultProblem(result, 'This BMC could not be inspected.')),
          name: machine.name,
          ip: machine.ip
        }
      }
      const facts = parseInspect(result.stdout)
      return { name: machine.name, ip: machine.ip, ...facts, problem: null }
    })
  }

  sensorRows(idRaw: unknown, revisionRaw: unknown): Promise<SensorResult> {
    const machine = this.findMachine(idRaw, revisionRaw)
    if (!machine) return Promise.resolve({ t: Date.now(), rows: [], problem: NO_MACHINE })
    return this.sensorCache.get(this.cacheKey(machine), async () => {
      const credential = await this.credentials.read(machine)
      if (!credential.password) {
        return { t: Date.now(), rows: [], problem: credential.problem }
      }
      const result = await runIpmi(this.ctx, machine, credential.password, 'sdr elist')
      if (!result.ok) {
        return {
          t: Date.now(),
          rows: [],
          problem: resultProblem(result, 'The sensors could not be read.')
        }
      }

      // A second command, and only for the drawer: `sdr elist` says whether a
      // reading is inside its thresholds and `sensor list` says what they are.
      // The sweep never asks for this - it is a per-machine cost paid only
      // while somebody has that machine's sensors on screen.
      const listed = await runIpmi(this.ctx, machine, credential.password, 'sensor list')
      const thresholds = listed.ok
        ? parseSensorThresholds(listed.stdout)
        : new Map<string, SensorThresholds>()

      return {
        t: Date.now(),
        rows: parseSdr(result.stdout).map((row) => {
          // Matched on the firmware's own name. `parseSdr` may have qualified a
          // duplicate as `Name #2`, and that qualified name is this module's
          // invention rather than anything `sensor list` knows about.
          const limits = thresholds.get(row.name.replace(/ #\d+$/, ''))
          const gap = limits && row.value != null ? headroom(row.value, limits) : null
          return {
            ...row,
            statusBadges: statusBadges(row.status),
            limit: limits && row.value != null ? nearestLimit(row.value, limits) : null,
            headroom: gap
          }
        }),
        problem: null
      }
    })
  }

  selRows(idRaw: unknown, revisionRaw: unknown): Promise<SelResult> {
    const machine = this.findMachine(idRaw, revisionRaw)
    if (!machine) {
      return Promise.resolve({ t: Date.now(), rows: [], problem: NO_MACHINE, clockWarning: null })
    }
    const count = this.config.settings().selFetchCount
    // The count is part of the key: it is the one loader whose command depends
    // on a setting, so sharing an entry across two values of it would go on
    // showing a hundred rows after somebody asked for a thousand.
    return this.selCache.get(`${this.cacheKey(machine)}\0${count}`, async () => {
      const credential = await this.credentials.read(machine)
      if (!credential.password) {
        return { t: Date.now(), rows: [], problem: credential.problem, clockWarning: null }
      }
      const result = await runIpmi(
        this.ctx,
        machine,
        credential.password,
        `sel elist last ${count}`
      )
      if (!result.ok) {
        return {
          t: Date.now(),
          rows: [],
          problem: resultProblem(result, 'The event log could not be read.'),
          clockWarning: null
        }
      }
      return {
        t: Date.now(),
        rows: parseSel(result.stdout),
        problem: null,
        clockWarning: describeDrift(this.clockFor(machine.id, machine.revision))
      }
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

  private findMachine(idRaw: unknown, revisionRaw: unknown): BmcMachine | undefined {
    const id = String(idRaw ?? '')
    const revision = String(revisionRaw ?? '')
    return this.config
      .read()
      .machines.find((machine) => machine.id === id && machine.revision === revision)
  }
}
