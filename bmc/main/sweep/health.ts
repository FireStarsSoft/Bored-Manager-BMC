/**
 * What a machine's state means, and how a rack's worth of them add up.
 *
 * The rule this file exists to enforce: a card is only green when nothing it
 * knows about is wrong. Before this, status came from the chassis power state
 * alone, so a machine whose fan had failed and whose inlet was at 90 °C
 * reported "Power on" in green - technically true, and the single most useful
 * thing this module could have told somebody, missed.
 */
import type { ValueFormat } from '@shared/module-ui'
import { BADGE, chip, type StatusChip } from '../badges'
import { failureLabel, type IpmiFailure, type ItemStatus, type PowerState } from '../ipmi'
import { machineAddress, type BmcConfig, type BmcMachine } from '../store'

export type ReachState = 'ok' | IpmiFailure | null

/** What the last sensor read found, kept per machine between sweeps. */
export interface SensorHealth {
  /** When these counts were taken, so the next sweep can decide to re-read. */
  at: number
  bad: number
  warn: number
  unknown: number
  total: number
  /** The rows worth naming on a card, worst first, capped. */
  worst: Array<{ name: string; status: ItemStatus; reading: string }>
  /** Set when the last read failed; the counts above are then the previous read's. */
  problem?: string
}

/** What a machine draws, when its controller will say. */
export interface PowerDraw {
  /** Instantaneous watts, or null when the last read produced none. */
  watts: number | null
  /**
   * False once the controller has told us it does not implement DCMI. Sticky
   * for the life of the entry: asking a board that has already refused, once
   * per sensor sweep, forever, is a command per machine per cycle spent
   * learning nothing.
   */
  supported: boolean
}

/**
 * How far the controller's own clock is from this machine's, in seconds.
 *
 * Worth knowing because every timestamp in the event log comes from that
 * clock. A controller running four hours out turns its whole log into
 * something nobody can line up against anything else - and unlike a failed
 * fan, nothing about it is visible until somebody tries to correlate an
 * incident and finds the times do not agree.
 */
export interface ClockDrift {
  at: number
  /** Positive when the BMC is ahead. Null when it has no clock set at all. */
  seconds: number | null
}

/** Past this, the event log's timestamps are not usable for correlation. */
export const CLOCK_DRIFT_WARN_SECONDS = 300

export interface MachineRuntimeState {
  revision: string
  power: PowerState | null
  reach: ReachState
  lastSeen: number | null
  lastError?: string
  sensors: SensorHealth | null
  draw: PowerDraw | null
  clock: ClockDrift | null
}

export interface CardChip {
  label: string
  status?: ItemStatus
  /** Set on anything not `ok`, so a card's "pinned only" switch shows faults. */
  pinned?: boolean
  /** Raw value to format, paired with `format` below - see StatusCardsBlock.items. */
  value?: number
  format?: ValueFormat
}

export interface MachineCard {
  id: string
  revision: string
  name: string
  ip: string
  port: number
  enabled: boolean
  status: ItemStatus
  powerLabel: string
  /** A one-line "power state · what is wrong" for the card's subtitle. */
  summary: string
  identifySeconds: number
  note: string
  chips: CardChip[]
}

export interface MachineCounts {
  total: number
  /** Entries the user has parked; they are shown and never swept. */
  disabled: number
  /** Entries actually being swept - the denominator for health. */
  monitored: number
  on: number
  off: number
  unreachable: number
  authFailed: number
  unknown: number
  /** Sensors across the whole fleet, not machines. */
  sensorsWarn: number
  sensorsBad: number
  /**
   * Watts drawn by every monitored machine whose controller reports it. Not a
   * total for the rack: machines that cannot answer are simply absent from it,
   * so `wattsFrom` says how many contributed and the figure can be read
   * honestly rather than as "the fleet draws this".
   */
  watts: number
  wattsFrom: number
  /** Machines bucketed by their own worst finding. */
  healthy: number
  warning: number
  critical: number
  /** 0 nothing wrong, 1 something to look at, 2 something is broken. */
  healthLevel: 0 | 1 | 2
  /** Share of monitored machines with nothing wrong; 100 when nothing is monitored. */
  healthPct: number
}

export interface MachinesPayload {
  t: number
  counts: MachineCounts
  machines: MachineCard[]
}

/**
 * Worst wins. `unknown` sits between `warn` and `ok` because not knowing is
 * worse than knowing everything is fine, and better than knowing it is not.
 */
export const STATUS_WEIGHT: Record<ItemStatus, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 }

export function worst(a: ItemStatus, b: ItemStatus): ItemStatus {
  return STATUS_WEIGHT[a] <= STATUS_WEIGHT[b] ? a : b
}

/** How many sensor rows to name on a card before it just gives a count. */
const NAMED_FAULTS = 2

/**
 * The severity a sensor read contributes to its machine.
 *
 * `unknown` rows are counted and reported but never folded in: an SDR entry
 * this module could not read is a gap in what it knows, and greying an
 * otherwise healthy card over one unparseable row would train people to
 * ignore the colour.
 */
export function foldSensors(sensors: SensorHealth): ItemStatus {
  if (sensors.bad > 0) return 'bad'
  if (sensors.warn > 0) return 'warn'
  return 'ok'
}

export interface StatePresentation {
  status: ItemStatus
  powerLabel: string
  summary: string
}

/**
 * A parked machine is deliberately not being asked anything, so it is neither
 * healthy nor broken - it is excluded from every count that feeds a colour.
 */
export function describeState(
  state: MachineRuntimeState | undefined,
  enabled = true
): StatePresentation {
  if (!enabled) {
    return { status: 'unknown', powerLabel: 'Sweeping disabled', summary: 'Parked - not being swept' }
  }
  if (!state?.reach) {
    return { status: 'unknown', powerLabel: 'Not checked yet', summary: 'Waiting for the first sweep' }
  }
  if (state.reach !== 'ok') {
    const label = failureLabel(state.reach)
    const status: ItemStatus = state.reach === 'auth' ? 'warn' : 'bad'
    return { status, powerLabel: label, summary: label }
  }

  const power: ItemStatus =
    state.power === 'on' ? 'ok' : state.power === 'off' ? 'unknown' : 'bad'
  const powerLabel =
    state.power === 'on' ? 'Power on' : state.power === 'off' ? 'Power off' : 'No power state'

  const sensors = state.sensors
  // A machine whose sensors have never been read is not "unknown" overall -
  // everything known about it is fine, so sensors contribute nothing.
  //
  // A read that failed is the interesting case. The last counts are still the
  // best evidence there is, so a known fault keeps its colour: a critical
  // sensor does not stop being critical because the controller went quiet.
  // What a failed read cannot do is go on certifying health, so a clean
  // machine drops to "unknown" rather than staying green on a reading nobody
  // has confirmed since.
  const contribution: ItemStatus = !sensors
    ? 'ok'
    : sensors.problem && foldSensors(sensors) === 'ok'
      ? 'unknown'
      : foldSensors(sensors)
  const status = worst(power, contribution)

  const faults: string[] = []
  if (sensors?.bad) faults.push(`${sensors.bad} sensor${sensors.bad === 1 ? '' : 's'} critical`)
  if (sensors?.warn) faults.push(`${sensors.warn} sensor${sensors.warn === 1 ? '' : 's'} warning`)
  if (sensors?.problem) faults.push('sensors unread')
  const drift = state.clock
  if (drift && (drift.seconds == null || Math.abs(drift.seconds) > CLOCK_DRIFT_WARN_SECONDS)) {
    faults.push(drift.seconds == null ? 'clock not set' : 'clock is off')
  }

  return {
    status,
    powerLabel,
    summary: faults.length ? `${powerLabel} · ${faults.join(', ')}` : powerLabel
  }
}

/** The chips a card carries under its title, faults first. */
function buildChips(
  machine: BmcMachine,
  state: MachineRuntimeState | undefined,
  presentation: StatePresentation
): CardChip[] {
  const chips: CardChip[] = [
    { label: machineAddress(machine) },
    { ...chip(presentation.powerLabel, presentation.status) }
  ]

  const sensors = state?.sensors
  if (machine.enabled && sensors) {
    for (const fault of sensors.worst.slice(0, NAMED_FAULTS)) {
      const reading = fault.reading && fault.reading !== 'No reading' ? ` ${fault.reading}` : ''
      chips.push({ ...chip(`${fault.name}${reading}`, fault.status) })
    }
    const named = Math.min(sensors.worst.length, NAMED_FAULTS)
    const remaining = sensors.bad + sensors.warn - named
    if (remaining > 0) chips.push({ ...chip(`${remaining} more not ok`, 'warn') })
    // Only the rows that actually reported are called ok. `total` counts the
    // unreadable ones too, and a card that certifies a sensor nobody could
    // read is the same overstatement in the other direction from greying a
    // healthy card over one.
    const reporting = sensors.total - sensors.unknown
    if (sensors.bad === 0 && sensors.warn === 0 && reporting > 0) {
      chips.push({ ...chip(`${reporting} sensors ok`, 'ok') })
    }
    if (sensors.unknown > 0) {
      chips.push({ ...chip(`${sensors.unknown} not reporting`, 'unknown') })
    }
    if (sensors.problem) chips.push({ ...chip('Sensors unread', 'unknown') })
  }

  // Never folded into the machine's status. A clock is wrong, not broken: the
  // hardware is fine, the log is what suffers, and colouring a healthy machine
  // amber over it would train people to ignore the colour.
  const drift = state?.clock
  if (machine.enabled && drift) {
    if (drift.seconds == null) {
      chips.push({ ...chip('BMC clock not set', 'unknown') })
    } else if (Math.abs(drift.seconds) > CLOCK_DRIFT_WARN_SECONDS) {
      const minutes = Math.round(Math.abs(drift.seconds) / 60)
      chips.push({
        ...chip(
          `BMC clock ${minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`} ${drift.seconds > 0 ? 'ahead' : 'behind'}`,
          'unknown'
        )
      })
    }
  }

  // Neutral, because a draw is a fact rather than a verdict: nothing here
  // knows what this machine ought to be drawing.
  if (machine.enabled && state?.draw?.watts != null) {
    chips.push({ label: `${state.draw.watts} W` })
  }

  chips.push(
    state?.lastSeen
      ? { label: 'seen', value: state.lastSeen, format: 'time' }
      : { label: 'never seen' }
  )
  return chips
}

function emptyCounts(total: number): MachineCounts {
  return {
    total,
    disabled: 0,
    monitored: 0,
    on: 0,
    off: 0,
    unreachable: 0,
    authFailed: 0,
    unknown: 0,
    sensorsWarn: 0,
    sensorsBad: 0,
    watts: 0,
    wattsFrom: 0,
    healthy: 0,
    warning: 0,
    critical: 0,
    healthLevel: 0,
    healthPct: 100
  }
}

export function buildMachinesPayload(
  config: BmcConfig,
  states: ReadonlyMap<string, MachineRuntimeState>,
  timestamp = Date.now()
): MachinesPayload {
  const counts = emptyCounts(config.machines.length)
  const identifySeconds = config.settings.identifySeconds

  const machines = config.machines.map((machine): MachineCard => {
    const candidate = states.get(machine.id)
    const state = candidate?.revision === machine.revision ? candidate : undefined
    const presentation = describeState(state, machine.enabled)

    if (!machine.enabled) {
      counts.disabled += 1
    } else {
      counts.monitored += 1
      if (state?.reach === 'ok' && state.power === 'on') counts.on += 1
      else if (state?.reach === 'ok' && state.power === 'off') counts.off += 1
      else if (state?.reach === 'auth') counts.authFailed += 1
      else if (!state?.reach) counts.unknown += 1
      else counts.unreachable += 1

      counts.sensorsBad += state?.sensors?.bad ?? 0
      counts.sensorsWarn += state?.sensors?.warn ?? 0
      if (state?.draw?.watts != null) {
        counts.watts += state.draw.watts
        counts.wattsFrom += 1
      }

      if (presentation.status === 'bad') counts.critical += 1
      else if (presentation.status === 'warn') counts.warning += 1
      // `unknown` - parked, not yet checked, or powered off - is neither a
      // fault nor a clean bill, and counts as healthy for the fleet figure:
      // nothing about it is wrong.
      else counts.healthy += 1
    }

    return {
      id: machine.id,
      revision: machine.revision,
      name: machine.name,
      ip: machine.ip,
      port: machine.port,
      enabled: machine.enabled,
      status: presentation.status,
      powerLabel: presentation.powerLabel,
      summary: presentation.summary,
      identifySeconds,
      note: machine.note ?? '',
      chips: buildChips(machine, state, presentation)
    }
  })

  counts.healthLevel = counts.critical > 0 ? 2 : counts.warning > 0 ? 1 : 0
  counts.healthPct =
    counts.monitored === 0 ? 100 : Math.floor((counts.healthy / counts.monitored) * 100)

  return { t: timestamp, counts, machines }
}

/**
 * The chips a fleet-level card carries, for the Overview wall.
 *
 * That card has room for one row of them, so when something is wrong the row
 * is spent naming it: the power chip repeats what the card's subtitle already
 * says, and would push a failing fan off the end. With nothing wrong there is
 * nothing to push, so the ordinary chips stay.
 */
export function machineChips(card: MachineCard): StatusChip[] {
  const withStatus = card.chips.filter(
    (entry): entry is CardChip & { status: ItemStatus } => Boolean(entry.status)
  )
  const faults = withStatus.filter((entry) => entry.status !== 'ok')
  const shown = faults.length > 0 ? faults : withStatus
  return shown.map((entry) => chip(entry.label, entry.status))
}

/** Colours for the per-sensor counts, so the widget and the pages agree. */
export const SENSOR_BADGE_COLORS = { bad: BADGE.bad, warn: BADGE.warn, ok: BADGE.good } as const
