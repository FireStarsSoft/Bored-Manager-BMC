/**
 * When each machine changed, kept for months rather than hours.
 *
 * The charts on the Trends tab come from `addHistory`, which the app sweeps
 * within forty-eight hours at the most. That is the right trade for a line on
 * a graph and the wrong one for the question people actually arrive with: *how
 * long has this been happening?* A fan that has been failing since Tuesday, a
 * controller that drops off the network every few days, a machine somebody
 * powered down a fortnight ago and forgot - none of those are visible in two
 * days of samples.
 *
 * So this writes a row when a machine's state *changes*, and only then. One
 * row per transition, keyed by machine id, kept for six months. A sweep a
 * minute against sixty-four machines that are all behaving writes nothing at
 * all, which is what makes six months affordable.
 */
import type { ModuleContext, ModuleRecord } from '@shared/modules'
import type { ItemStatus } from '../ipmi'
import type { MachineCard, MachinesPayload } from './health'

/** The record set declared in `module.json`. */
export const INCIDENT_SET = 'incidents'

/** How many rows the page asks for; a table nobody scrolls past is wasted work. */
const PAGE = 200

export interface IncidentRow extends Record<string, unknown> {
  id: string
  t: number
  machine: string
  from: ItemStatus
  to: ItemStatus
  /** The card's own summary at the moment it changed - "Power on · 1 sensor critical". */
  detail: string
}

/**
 * Watches the fleet and writes down what changed.
 *
 * Deliberately not the sweeper's job: the sweeper decides what is true now,
 * and this decides what is worth remembering, which is a different question
 * with a different failure mode. A bug here should cost a missing row, never a
 * wrong card.
 */
export class Incidents {
  /** The last status written down for each machine, by id. */
  private seen = new Map<string, ItemStatus>()

  constructor(private ctx: ModuleContext) {}

  /**
   * Compare this sweep against the last and record the differences.
   *
   * The first sighting of a machine is never an incident. Everything would be
   * one on the first sweep after a restart, and a log that fills with "this
   * machine exists" the moment the app starts is a log nobody reads.
   */
  observe(payload: MachinesPayload): void {
    const rows: ModuleRecord[] = []
    const present = new Set<string>()

    for (const card of payload.machines) {
      present.add(card.id)
      // A parked machine is not being asked anything, so it has no state to
      // change. Forgetting it means resuming one is a fresh first sighting
      // rather than a transition out of whatever it was a fortnight ago.
      if (!card.enabled) {
        this.seen.delete(card.id)
        continue
      }
      // "Not checked yet" is the absence of a reading, not a state a machine
      // was in. Writing it down would put a row in the log every time the app
      // reconnected.
      if (card.status === 'unknown' && card.powerLabel === 'Not checked yet') continue

      const before = this.seen.get(card.id)
      this.seen.set(card.id, card.status)
      if (before === undefined || before === card.status) continue
      rows.push(this.rowFor(card, before, payload.t))
    }

    for (const id of [...this.seen.keys()]) {
      if (!present.has(id)) this.seen.delete(id)
    }

    if (rows.length === 0) return
    // Detached: a sweep must not fail, or wait, because a log could not be
    // written. The rows are the record of something that already happened.
    void this.ctx.recordAppend(INCIDENT_SET, rows).catch((error: unknown) => {
      this.ctx.log(
        `bmc: could not write ${rows.length} incident row(s) - ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  private rowFor(card: MachineCard, from: ItemStatus, t: number): ModuleRecord {
    return {
      t,
      // Keyed by machine so one machine's history can be asked for on its own,
      // which is the whole reason a record set has a key at all.
      key: card.id,
      machine: card.name,
      from,
      to: card.status,
      detail: card.summary
    }
  }

  /** The newest transitions, for the page that shows them. */
  async recent(limit = PAGE): Promise<IncidentRow[]> {
    try {
      const page = await this.ctx.recordQuery(INCIDENT_SET, { order: 'desc', limit })
      return page.rows.map((row, index) => ({
        // Rows have no id of their own; a table needs a stable one per render.
        id: `${row.t}:${String(row.key ?? '')}:${index}`,
        t: row.t,
        machine: typeof row.machine === 'string' ? row.machine : String(row.key ?? ''),
        from: (row.from as ItemStatus) ?? 'unknown',
        to: (row.to as ItemStatus) ?? 'unknown',
        detail: typeof row.detail === 'string' ? row.detail : ''
      }))
    } catch {
      // An unreadable log is not worth an error page: the fleet view is what
      // matters and it is unaffected.
      return []
    }
  }

  reset(): void {
    this.seen.clear()
  }
}
