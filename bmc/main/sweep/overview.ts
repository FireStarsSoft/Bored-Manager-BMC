/**
 * The Overview card's payload.
 *
 * This file used to contain a timer. Until Bored Manager 0.6.0 a block spec
 * could not ask for movement, so the only way to make a critical fleet catch
 * somebody's eye was to re-publish the meter's value about once a second and
 * let the bar jump between two numbers - a blink made of data, running a
 * poller and an emit per second for as long as anything was wrong.
 *
 * 0.6.0 added an `attention` clause: a spec says *when* something is urgent
 * and the app decides what urgent looks like. So the timer is gone, the module
 * publishes once per sweep like everything else, and what is left here is the
 * one honest number the widget needs.
 *
 * That number is still chosen against the renderer's meter bands, which colour
 * a bar by how full it is (>= 90 destructive, >= 70 warning, below that the
 * ordinary tint - the same bars the per-core CPU readout uses). A warning is
 * pinned into 70-89 so it always *looks* like a warning and only its length
 * varies with how much of the fleet is affected; anything critical goes to the
 * top of the range, because how many machines are broken does not change what
 * has to happen next.
 */
import type { ModuleContext } from '@shared/modules'
import type { ItemStatus } from '../ipmi'
import type { StatusChip } from '../badges'
import { machineChips, type MachineCard, type MachineCounts, type MachinesPayload } from './health'

export interface OverviewMachine {
  id: string
  name: string
  status: ItemStatus
  summary: string
  /** Read by the widget's `attentionKey`; only the critical ones move. */
  attention: boolean
  chips: StatusChip[]
}

export interface OverviewPayload {
  t: number
  /** 0 nothing wrong, 1 something to look at, 2 something is broken. */
  healthLevel: 0 | 1 | 2
  healthPct: number
  /** 0-100 for the attention meter; steady, and read for its colour and length. */
  meterValue: number
  label: string
  counts: MachineCounts
  machines: OverviewMachine[]
  /** Machines the wall did not have room for; always the healthiest ones. */
  hidden: number
}

/**
 * How many cards the Overview wall shows. The list is sorted worst-first
 * before it is cut, so what is dropped is always the machines with nothing
 * wrong - and how many were dropped is reported rather than left implied.
 */
const WALL_CARDS = 12

/** The renderer's red band. */
const CRITICAL = 96
/**
 * The band a warning may move within: inside the amber zone at the bottom end,
 * and below the red one at the top. The low end is the amber threshold itself
 * rather than a small number - one warned machine out of twenty is still a
 * warning, and a bar drawn in the ordinary tint says nothing is wrong.
 */
const WARNING_MIN = 70
const WARNING_MAX = 89

const CARD_ORDER: Record<ItemStatus, number> = { bad: 0, warn: 1, unknown: 2, ok: 3 }

function describeFleet(counts: MachineCounts): string {
  if (counts.monitored === 0) {
    return counts.total === 0 ? 'No machines saved yet' : 'Every machine is parked'
  }
  const troubled = counts.critical + counts.warning
  if (troubled === 0) {
    return counts.monitored === 1 ? 'The one machine is healthy' : `All ${counts.monitored} machines healthy`
  }
  return `${troubled} of ${counts.monitored} need attention`
}

/**
 * A warning scales with how much of the fleet it covers - one machine out of
 * twenty is a different morning from nineteen - while anything critical goes
 * straight to the top of the range.
 */
function meterFor(counts: MachineCounts): number {
  if (counts.healthLevel === 0) return 0
  if (counts.healthLevel === 2) return CRITICAL
  const share = counts.monitored === 0 ? 0 : (counts.warning / counts.monitored) * 100
  return Math.max(WARNING_MIN, Math.min(WARNING_MAX, Math.round(share)))
}

export function buildOverview(payload: MachinesPayload): OverviewPayload {
  const ordered = [...payload.machines]
    .filter((card) => card.enabled)
    .sort((a, b) => CARD_ORDER[a.status] - CARD_ORDER[b.status] || a.name.localeCompare(b.name))

  const machines = ordered.slice(0, WALL_CARDS).map(
    (card: MachineCard): OverviewMachine => ({
      id: card.id,
      name: card.name,
      status: card.status,
      summary: card.summary,
      // Only the broken ones. A wall where every amber card moves is a wall
      // that says nothing about which one to open first.
      attention: card.status === 'bad',
      chips: machineChips(card)
    })
  )

  return {
    t: payload.t,
    healthLevel: payload.counts.healthLevel,
    healthPct: payload.counts.healthPct,
    meterValue: meterFor(payload.counts),
    label: describeFleet(payload.counts),
    counts: payload.counts,
    machines,
    hidden: Math.max(0, ordered.length - machines.length)
  }
}

/**
 * The single owner of the `overview` stream.
 *
 * One emit per sweep. There is nothing to coordinate any more now that the
 * movement belongs to the renderer, so this is a thin thing - kept as a class
 * because the runtime container owns it and resets it, and because a future
 * per-machine detail would land here rather than in the sweeper.
 */
export class OverviewPublisher {
  latest: OverviewPayload | null = null

  private stopped = false
  /** What the fleet was last time, so only a change is worth interrupting for. */
  private announced: 0 | 1 | 2 | null = null

  constructor(private ctx: ModuleContext) {}

  publish(payload: MachinesPayload): OverviewPayload {
    const next = buildOverview(payload)
    this.latest = next
    if (!this.stopped) {
      this.ctx.emit('overview', next)
      this.announce(next)
    }
    return next
  }

  /**
   * Say something, once, when the fleet crosses into or out of trouble.
   *
   * Everything this module knows lives on its own pages, so without this a
   * rack going critical is invisible to anybody looking at a terminal. What
   * makes it bearable is that it fires on a *change* rather than on a state:
   * a sweep runs every minute and the fleet stays bad for hours, so announcing
   * the state would be an interruption an hour, forever. The app rate-limits
   * this as well, but a module that leans on that is a module that would
   * deserve to be rate-limited.
   */
  private announce(next: OverviewPayload): void {
    const level = next.healthLevel
    const before = this.announced
    this.announced = level
    // Nothing to compare against on the first sweep after a connect. Saying
    // "still fine" to somebody who just opened the app is noise, and saying
    // "critical" for a fault that has been there all week reads as new.
    if (before === null || before === level) return
    if (typeof this.ctx.notify !== 'function') return

    if (level === 2) {
      this.ctx.notify({
        key: 'fleet-critical',
        level: 'error',
        title: `BMC: ${next.counts.critical} machine${next.counts.critical === 1 ? '' : 's'} critical`,
        body: next.label
      })
      return
    }
    if (before === 2) {
      this.ctx.notify({
        // A different key from the alarm on purpose. They are two different
        // things to say, and sharing one would have the app's own per-key
        // dedupe swallow a recovery that lands inside a minute of the alarm -
        // leaving somebody holding a warning that has already cleared.
        key: 'fleet-recovered',
        level: 'info',
        title: 'BMC: nothing is critical any more',
        body: next.label
      })
    }
  }

  reset(): void {
    this.latest = null
    // A reconnect or a machine switch starts the comparison over: the first
    // sweep after one is a first look, not a change.
    this.announced = null
  }

  dispose(): void {
    this.stopped = true
  }
}
