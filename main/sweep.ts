import type { ModuleContext, ModulePoller } from '@shared/modules'
import {
  SWEEP_CONCURRENCY,
  machineFingerprint,
  type BmcConfig,
  type BmcMachine,
  type ConfigStore
} from './config'
import { runIpmi } from './ipmi'
import { parsePowerStatus, type IpmiFailure, type ItemStatus, type PowerState } from './parse'
import type { BmcCapabilities } from './probe'

export type ReachState = 'ok' | IpmiFailure | null

export interface MachineRuntimeState {
  revision: string
  power: PowerState | null
  reach: ReachState
  lastSeen: number | null
  lastError?: string
}

interface CardChip {
  label: string
  status?: ItemStatus
}

export interface MachineCard {
  id: string
  revision: string
  name: string
  ip: string
  port: number
  status: ItemStatus
  powerLabel: string
  identifySeconds: number
  note: string
  chips: CardChip[]
}

export interface MachineCounts {
  total: number
  on: number
  off: number
  unreachable: number
  authFailed: number
  unknown: number
}

export interface MachinesPayload {
  t: number
  counts: MachineCounts
  machines: MachineCard[]
}

export interface SeriesPoint {
  t: number
  on: number
  off: number
  unreachable: number
  authFailed: number
}

const SERIES_WINDOW_MS = 5 * 60 * 1000

function clock(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function describeState(state: MachineRuntimeState | undefined): {
  status: ItemStatus
  powerLabel: string
} {
  if (!state?.reach) return { status: 'unknown', powerLabel: 'Not checked yet' }
  if (state.reach === 'auth') return { status: 'warn', powerLabel: 'Auth failed' }
  if (state.reach !== 'ok') return { status: 'bad', powerLabel: 'Unreachable' }
  if (state.power === 'on') return { status: 'ok', powerLabel: 'Power on' }
  if (state.power === 'off') return { status: 'unknown', powerLabel: 'Power off' }
  return { status: 'bad', powerLabel: 'Unreachable' }
}

export function buildMachinesPayload(
  config: BmcConfig,
  states: ReadonlyMap<string, MachineRuntimeState>,
  timestamp = Date.now()
): MachinesPayload {
  const counts: MachineCounts = {
    total: config.machines.length,
    on: 0,
    off: 0,
    unreachable: 0,
    authFailed: 0,
    unknown: 0
  }

  const machines = config.machines.map((machine): MachineCard => {
    const candidate = states.get(machine.id)
    const state = candidate?.revision === machine.revision ? candidate : undefined
    const presentation = describeState(state)
    if (state?.reach === 'ok' && state.power === 'on') counts.on += 1
    else if (state?.reach === 'ok' && state.power === 'off') counts.off += 1
    else if (state?.reach === 'auth') counts.authFailed += 1
    else if (!state?.reach) counts.unknown += 1
    else counts.unreachable += 1

    const address = machine.port === 623 ? machine.ip : `${machine.ip}:${machine.port}`
    return {
      id: machine.id,
      revision: machine.revision,
      name: machine.name,
      ip: machine.ip,
      port: machine.port,
      status: presentation.status,
      powerLabel: presentation.powerLabel,
      identifySeconds: 15,
      note: machine.note ?? '',
      chips: [
        { label: address },
        { label: presentation.powerLabel, status: presentation.status },
        { label: state?.lastSeen ? `seen ${clock(state.lastSeen)}` : 'never seen' }
      ]
    }
  })

  return { t: timestamp, counts, machines }
}

export class Sweeper {
  readonly poller: ModulePoller
  latest: MachinesPayload | null = null
  series: SeriesPoint[] = []

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
    private ensureCapabilities: () => Promise<BmcCapabilities>
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
    if (!machine) return
    const fingerprint = machineFingerprint(machine)
    const version = this.bumpStateVersion(id)
    const next = await this.readState(machine, this.stateFor(id, machine.revision))
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
    return payload
  }

  reset(): void {
    this.generation += 1
    this.states.clear()
    this.stateVersions.clear()
    this.latest = null
    this.series = []
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

  private async readState(
    machine: BmcMachine,
    previous: MachineRuntimeState | undefined
  ): Promise<MachineRuntimeState> {
    const result = await runIpmi(this.ctx, machine, 'chassis power status')
    if (!result.ok) {
      return {
        revision: machine.revision,
        power: previous?.power ?? null,
        reach: result.failure ?? 'error',
        lastSeen: previous?.lastSeen ?? null,
        lastError: result.message ?? 'ipmitool failed'
      }
    }

    const power = parsePowerStatus(result.stdout)
    if (!power) {
      return {
        revision: machine.revision,
        power: null,
        reach: 'error',
        lastSeen: Date.now(),
        lastError: 'The BMC answer did not contain a chassis power state.'
      }
    }
    return { revision: machine.revision, power, reach: 'ok', lastSeen: Date.now() }
  }

  private publishFull(): void {
    const payload = this.publishCards()
    const point: SeriesPoint = {
      t: payload.t,
      on: payload.counts.on,
      off: payload.counts.off,
      unreachable: payload.counts.unreachable,
      authFailed: payload.counts.authFailed
    }
    this.series.push(point)
    const cutoff = point.t - SERIES_WINDOW_MS
    while (this.series.length && this.series[0].t < cutoff) this.series.shift()
    this.ctx.emit('series', point)
    this.ctx.addHistory({
      t: point.t,
      on: point.on,
      off: point.off,
      unreachable: point.unreachable,
      authFailed: point.authFailed
    })
  }

  private async sweep(generation: number): Promise<void> {
    if (!this.active(generation)) return
    const capabilities = await this.ensureCapabilities()
    if (!this.active(generation)) return
    if (capabilities.problem) {
      this.publishCards()
      return
    }

    const machines = [...this.config.read().machines]
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
        const next = await this.readState(
          machine,
          this.stateFor(machine.id, machine.revision)
        )
        if (!this.active(generation)) return
        updates.set(machine.id, {
          state: next,
          version: versions.get(machine.id) ?? 0,
          fingerprint: machineFingerprint(machine)
        })
      }
    }

    const count = Math.min(SWEEP_CONCURRENCY, machines.length)
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
