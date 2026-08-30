import type { ModuleContext, ModulePoller } from '@shared/modules'
import type { ValueBadge } from '@shared/module-ui'
import { statusBadges } from '../badges'
import {
  parseDcmiWatts,
  parsePowerStatus,
  parseSelTime,
  parseSdr,
  resultProblem,
  runIpmi,
  type ItemStatus
} from '../ipmi'
import {
  machineAddress,
  machineFingerprint,
  type BmcMachine,
  type ConfigStore,
  type Credentials
} from '../store'
import {
  buildMachinesPayload,
  type MachineRuntimeState,
  type ClockDrift,
  type MachinesPayload,
  type PowerDraw,
  type SensorHealth
} from './health'
import type { SeriesLog } from './history'
import type { Incidents } from './incidents'

export const INTERVAL_KEY = 'bmc'

/** One sensor, somewhere in the fleet, that is not ok. */
export interface AttentionRow extends Record<string, unknown> {
  id: string
  machine: string
  address: string
  sensor: string
  reading: string
  status: ItemStatus
  statusBadges: ValueBadge[]
}

/**
 * How many faulty sensors are kept per machine.
 *
 * A card names two of them and counts the rest, but the fleet-wide attention
 * table lists them, so this is sized for that: enough that a machine having a
 * genuinely bad day is described rather than summarised, and small enough that
 * sixty-four of them are still a few hundred small objects.
 */
const WORST_KEPT = 12

/**
 * How often a controller's clock is worth asking about.
 *
 * Drift changes by one second per second, so a reading an hour old is as good
 * as a fresh one for deciding whether an event log can be lined up against
 * anything. Putting it on the sensor cadence cost a fourth command per machine
 * per sensor sweep - real load on controllers the user did not agree to have
 * hammered - for a number that had not meaningfully moved.
 */
const CLOCK_PERIOD_MS = 60 * 60_000

/**
 * The sweep: one pass over every machine the user has not parked.
 *
 * Two things make this more careful than a loop. The first is cost - each
 * machine is a network round trip to a controller that answers slowly, so the
 * pass is bounded by a worker pool and sensors are read on a slower cadence
 * than power. The second is staleness: credentials can change, a machine can
 * be deleted, and the module can be disposed while a read is still in the air.
 * A result that arrives after any of those is discarded rather than written,
 * because a card showing what an endpoint said before the user re-pointed it
 * is worse than a card showing nothing.
 */
export class Sweeper {
  readonly poller: ModulePoller
  latest: MachinesPayload | null = null
  /**
   * Set by the runtime container once the Overview publisher exists. A
   * callback rather than a constructor dependency so the sweep poller is
   * still the first one this module registers, which is what its tests and
   * anybody reading a poller list expect.
   */
  onPublish: ((payload: MachinesPayload) => void) | null = null

  private states = new Map<string, MachineRuntimeState>()
  private stateVersions = new Map<string, number>()
  private inFlight: Promise<void> | null = null
  private inFlightGeneration = -1
  private queued: Promise<void> | null = null
  private generation = 0
  private stopped = false

  constructor(
    private ctx: ModuleContext,
    private config: ConfigStore,
    private ensureReady: () => Promise<boolean>,
    private series: SeriesLog,
    private credentials: Credentials,
    private incidents: Incidents
  ) {
    this.poller = ctx.createPoller('bmc:sweep', () => this.run())
  }

  stateFor(id: string, revision: string): MachineRuntimeState | undefined {
    const state = this.states.get(id)
    return state?.revision === revision ? state : undefined
  }

  snapshot(): MachinesPayload {
    return this.latest ?? buildMachinesPayload(this.config.read(), this.states)
  }

  /**
   * Every sensor across the fleet that is not ok, in one list.
   *
   * Built from what the sweep already collected, so asking costs nothing on
   * the network - which is the point. Before this, finding out what was wrong
   * with a rack meant opening cards one at a time until the red one turned up.
   */
  attentionRows(): AttentionRow[] {
    const rows: AttentionRow[] = []
    for (const machine of this.config.read().machines) {
      if (!machine.enabled) continue
      const state = this.stateFor(machine.id, machine.revision)
      for (const fault of state?.sensors?.worst ?? []) {
        rows.push({
          id: `${machine.id}::${fault.name}`,
          machine: machine.name,
          address: machineAddress(machine),
          sensor: fault.name,
          reading: fault.reading,
          status: fault.status,
          statusBadges: statusBadges(fault.status)
        })
      }
    }
    // Critical first, then by machine, so the top of the table is the top of
    // the to-do list rather than whatever the config document happened to list
    // first.
    return rows.sort(
      (a, b) =>
        (a.status === b.status ? 0 : a.status === 'bad' ? -1 : 1) ||
        a.machine.localeCompare(b.machine) ||
        a.sensor.localeCompare(b.sensor)
    )
  }

  /** One full sweep at a time; calls in the same session join the current run. */
  run(): Promise<void> {
    if (this.inFlight) {
      if (this.inFlightGeneration === this.generation) return this.inFlight
      if (!this.queued) {
        this.queued = this.inFlight.then(() => {
          this.queued = null
          return this.run()
        })
      }
      return this.queued
    }
    const generation = this.generation
    this.inFlightGeneration = generation
    const pending = this.sweep(generation).finally(() => {
      if (this.inFlight === pending) this.inFlight = null
    })
    this.inFlight = pending
    return pending
  }

  /** Re-read one machine after an action, without adding a history point. */
  async refreshOne(id: string): Promise<void> {
    if (!this.ctx.connected || this.stopped) return
    const generation = this.generation
    const machine = this.config.read().machines.find((entry) => entry.id === id)
    if (!machine || !machine.enabled) return
    const fingerprint = machineFingerprint(machine)
    const version = this.bumpStateVersion(id)
    const previous = this.stateFor(id, machine.revision)
    const next = await this.readState(machine, previous, this.wantsSensors(previous), () =>
      this.stillCurrent(machine, generation, version)
    )
    if (!this.active(generation)) return
    if (this.stateVersion(id) !== version) return
    const current = this.config.read().machines.find((entry) => entry.id === id)
    if (!current || machineFingerprint(current) !== fingerprint) return
    this.states.set(id, next)
    this.publishCards()
  }

  /** Forget stale status after credentials change or a machine is deleted. */
  forgetMachine(id: string): void {
    this.bumpStateVersion(id)
    this.states.delete(id)
    this.publishCards()
  }

  publishCards(): MachinesPayload {
    const configured = new Map(
      this.config.read().machines.map((machine) => [machine.id, machine.revision])
    )
    for (const [id, state] of this.states) {
      if (configured.get(id) !== state.revision) this.states.delete(id)
    }
    for (const id of this.stateVersions.keys()) {
      if (!configured.has(id)) this.stateVersions.delete(id)
    }
    const payload = buildMachinesPayload(this.config.read(), this.states)
    this.latest = payload
    this.ctx.emit('machines', payload)
    this.incidents.observe(payload)
    this.onPublish?.(payload)
    return payload
  }

  reset(): void {
    this.generation += 1
    this.states.clear()
    this.stateVersions.clear()
    this.latest = null
    this.series.reset()
    this.incidents.reset()
  }

  dispose(): void {
    this.stopped = true
    this.generation += 1
    this.poller.stop()
  }

  private active(generation: number): boolean {
    return !this.stopped && generation === this.generation && this.ctx.connected
  }

  private stateVersion(id: string): number {
    return this.stateVersions.get(id) ?? 0
  }

  private bumpStateVersion(id: string): number {
    const next = this.stateVersion(id) + 1
    this.stateVersions.set(id, next)
    return next
  }

  /**
   * Whether a read that is already in the air is still worth finishing.
   *
   * Deliberately the same question the commit asks: the machine has to still
   * be configured, with the fingerprint it had when the read started. Asking
   * it only about `stateVersions` was not enough - `publishCards` prunes those
   * for machines that have left the list, which erased the very bump that
   * `forgetMachine` had just made for a deleted one, and the gate reopened in
   * time to send a second command to a BMC the user had removed.
   */
  private stillCurrent(machine: BmcMachine, generation: number, version: number): boolean {
    if (!this.active(generation)) return false
    if (this.stateVersion(machine.id) !== version) return false
    const fingerprint = machineFingerprint(machine)
    return this.config
      .read()
      .machines.some(
        (entry) => entry.id === machine.id && machineFingerprint(entry) === fingerprint
      )
  }

  /**
   * How long a sensor reading may go unrefreshed.
   *
   * Deliberately a time rather than a counter. A counter would make a manual
   * "sweep now" pay for sensors it just read, would leave a machine added
   * mid-cycle waiting for the count to come round, and would have to be
   * migrated across the generation bumps everything else here relies on.
   */
  private sensorPeriodMs(): number {
    const every = this.config.settings().sensorEverySweeps
    if (every <= 0) return Number.POSITIVE_INFINITY
    if (every === 1) return 0
    const base = Math.max(30, this.ctx.slowIntervalSec(INTERVAL_KEY) || 60) * 1000
    // Half a sweep of slack, so ordinary timer drift never pushes a due read
    // into the following cycle and halves the real cadence.
    return every * base - base / 2
  }

  private wantsSensors(previous: MachineRuntimeState | undefined): boolean {
    const period = this.sensorPeriodMs()
    if (!Number.isFinite(period)) return false
    return Date.now() - (previous?.sensors?.at ?? 0) >= period
  }

  private async readSensors(
    machine: BmcMachine,
    password: string,
    previous: SensorHealth | null
  ): Promise<SensorHealth> {
    const result = await runIpmi(this.ctx, machine, password, 'sdr elist')
    if (!result.ok) {
      // Keep the last counts so a drawer still has something to show, and say
      // plainly that they are not current. Silently keeping them would let a
      // card stay green on readings nobody has confirmed since.
      return {
        at: previous?.at ?? 0,
        bad: previous?.bad ?? 0,
        warn: previous?.warn ?? 0,
        unknown: previous?.unknown ?? 0,
        total: previous?.total ?? 0,
        worst: previous?.worst ?? [],
        problem: resultProblem(result, 'The sensors could not be read.')
      }
    }

    const rows = parseSdr(result.stdout)
    const bad = rows.filter((row) => row.status === 'bad')
    const warn = rows.filter((row) => row.status === 'warn')
    // Critical first, so the names a card has room for are the ones that matter.
    const faulty = [...bad, ...warn]
    return {
      at: Date.now(),
      bad: bad.length,
      warn: warn.length,
      unknown: rows.filter((row) => row.status === 'unknown').length,
      total: rows.length,
      worst: faulty.slice(0, WORST_KEPT).map((row) => ({
        name: row.name,
        status: row.status,
        reading: row.reading
      }))
    }
  }

  /**
   * What the machine is drawing, when its controller implements DCMI.
   *
   * Plenty do not, and the ones that do not say so the same way every time -
   * so the first refusal is remembered and never asked again for that entry.
   * Otherwise this would be one wasted command per machine per sensor sweep,
   * for the life of the install, to re-learn something already known.
   */
  private async readDraw(
    machine: BmcMachine,
    password: string,
    previous: PowerDraw | null
  ): Promise<PowerDraw | null> {
    if (previous && !previous.supported) return previous
    const result = await runIpmi(this.ctx, machine, password, 'dcmi power reading')
    if (!result.ok) {
      // A controller that refuses the command is answering, so this is not a
      // fault to report - it is a capability this board does not have, and
      // saying so once is the whole point.
      return { watts: null, supported: false }
    }
    const watts = parseDcmiWatts(result.stdout)
    // It answered the command but gave no figure: the command exists, so keep
    // asking - a reading can appear once the chassis is drawing something.
    return { watts, supported: true }
  }

  /**
   * How far the controller's clock is from this machine's.
   *
   * On the sensor cadence rather than every sweep: a clock that is four hours
   * out has been four hours out for a while and will still be four hours out
   * in three minutes. Reading it every sweep would be a command per machine
   * per cycle for a number that changes by one second per second.
   */
  private async readClock(
    machine: BmcMachine,
    password: string,
    previous: ClockDrift | null
  ): Promise<ClockDrift | null> {
    const result = await runIpmi(this.ctx, machine, password, 'sel time get')
    // A controller that will not answer keeps whatever was last known: this is
    // an aside, and losing it should never look like a finding of its own.
    if (!result.ok) return previous
    const at = parseSelTime(result.stdout)
    if (at == null) return { at: Date.now(), seconds: null }
    return { at: Date.now(), seconds: Math.round((at - Date.now()) / 1000) }
  }

  private async readState(
    machine: BmcMachine,
    previous: MachineRuntimeState | undefined,
    wantSensors: boolean,
    stillWanted: () => boolean
  ): Promise<MachineRuntimeState> {
    // Fetched for this pass and dropped with it: a password kept in a field
    // could reach a browser through `snapshots()`, and one fetched per sweep
    // costs a map lookup beside a network round trip.
    const credential = await this.credentials.read(machine)
    if (!credential.password) {
      return {
        revision: machine.revision,
        power: previous?.power ?? null,
        // A credential this module cannot use is an authentication problem,
        // which is what `auth` already means to a card - amber, not red, and
        // pointing at the settings page rather than at the network.
        reach: 'auth',
        lastSeen: previous?.lastSeen ?? null,
        lastError: credential.problem ?? 'This BMC has no usable password.',
        sensors: previous?.sensors ?? null,
        draw: previous?.draw ?? null,
        clock: previous?.clock ?? null
      }
    }

    const result = await runIpmi(this.ctx, machine, credential.password, 'chassis power status')
    if (!result.ok) {
      return {
        revision: machine.revision,
        power: previous?.power ?? null,
        reach: result.failure ?? 'error',
        lastSeen: previous?.lastSeen ?? null,
        lastError: resultProblem(result, 'ipmitool failed.'),
        sensors: previous?.sensors ?? null,
        draw: previous?.draw ?? null,
        clock: previous?.clock ?? null
      }
    }

    const power = parsePowerStatus(result.stdout)
    if (!power) {
      return {
        revision: machine.revision,
        power: null,
        // It answered - this is not a network fault, and calling it one sends
        // somebody to check cabling for a firmware quirk.
        reach: 'ok',
        lastSeen: Date.now(),
        lastError: 'The BMC answered without a chassis power state in its reply.',
        sensors: previous?.sensors ?? null,
        draw: previous?.draw ?? null,
        clock: previous?.clock ?? null
      }
    }

    // Between the two commands is the one place this module could reach an
    // endpoint it has been told to stop touching: the power read may have
    // taken fifteen seconds, and the module can have been disposed, or the
    // machine re-credentialed, in that time. The result below is discarded by
    // the caller either way - the point of stopping here is not to send the
    // second command at all, with the old password, to an address the user has
    // since re-pointed.
    if (!stillWanted()) {
      return {
        revision: machine.revision,
        power,
        reach: 'ok',
        lastSeen: Date.now(),
        sensors: previous?.sensors ?? null,
        draw: previous?.draw ?? null,
        clock: previous?.clock ?? null
      }
    }

    // With sensor folding switched off the readings are dropped rather than
    // kept, so a card cannot go on being coloured by numbers nobody is
    // refreshing any more.
    const sensorsOn = this.config.settings().sensorEverySweeps > 0
    let sensors: SensorHealth | null = null
    let draw: PowerDraw | null = previous?.draw ?? null
    let clock: ClockDrift | null = previous?.clock ?? null
    if (sensorsOn) {
      if (wantSensors) {
        sensors = await this.readSensors(machine, credential.password, previous?.sensors ?? null)
        draw = await this.readDraw(machine, credential.password, draw)
        if (Date.now() - (clock?.at ?? 0) >= CLOCK_PERIOD_MS) {
          clock = await this.readClock(machine, credential.password, clock)
        }
      } else {
        sensors = previous?.sensors ?? null
      }
    } else {
      draw = null
      clock = null
    }

    return { revision: machine.revision, power, reach: 'ok', lastSeen: Date.now(), sensors, draw, clock }
  }

  private publishFull(): void {
    const payload = this.publishCards()
    this.series.append(payload)
  }

  private async sweep(generation: number): Promise<void> {
    if (!this.active(generation)) return
    const ready = await this.ensureReady()
    if (!this.active(generation)) return
    if (!ready) {
      this.publishCards()
      return
    }

    // Parked machines still get a card; they just never get a command.
    const machines = this.config.read().machines.filter((machine) => machine.enabled)
    if (machines.length === 0) {
      this.states.clear()
      this.publishFull()
      return
    }

    let cursor = 0
    const updates = new Map<
      string,
      { state: MachineRuntimeState; version: number; fingerprint: string }
    >()
    const versions = new Map(machines.map((machine) => [machine.id, this.stateVersion(machine.id)]))
    const worker = async (): Promise<void> => {
      while (this.active(generation)) {
        const at = cursor
        cursor += 1
        const machine = machines[at]
        if (!machine) return
        const previous = this.stateFor(machine.id, machine.revision)
        const next = await this.readState(machine, previous, this.wantsSensors(previous), () =>
          this.stillCurrent(machine, generation, versions.get(machine.id) ?? 0)
        )
        if (!this.active(generation)) return
        updates.set(machine.id, {
          state: next,
          version: versions.get(machine.id) ?? 0,
          fingerprint: machineFingerprint(machine)
        })
      }
    }

    const count = Math.min(this.config.settings().sweepConcurrency, machines.length)
    await Promise.all(Array.from({ length: count }, () => worker()))
    if (!this.active(generation)) return

    const current = new Map(
      this.config.read().machines.map((machine) => [machine.id, machineFingerprint(machine)])
    )
    for (const [id, update] of updates) {
      if (this.stateVersion(id) !== update.version) continue
      if (current.get(id) !== update.fingerprint) continue
      this.states.set(id, update.state)
    }
    this.publishFull()
  }
}
