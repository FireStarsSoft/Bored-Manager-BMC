/**
 * One point per sweep, for the charts and for the metrics archive.
 *
 * The two sensor keys are additive: a chart spec that only names the four
 * power keys keeps working, and the archive gains a fleet fault count it can
 * be asked about later ("when did this start?" is the question a status colour
 * cannot answer).
 */
import type { ModuleContext } from '@shared/modules'
import type { MachinesPayload } from './health'

export interface SeriesPoint {
  t: number
  on: number
  off: number
  unreachable: number
  authFailed: number
  sensorsWarn: number
  sensorsBad: number
  /** Watts, summed over the machines whose controllers report a draw. */
  watts: number
}

const SERIES_WINDOW_MS = 5 * 60 * 1000

export function pointFrom(payload: MachinesPayload): SeriesPoint {
  return {
    t: payload.t,
    on: payload.counts.on,
    off: payload.counts.off,
    unreachable: payload.counts.unreachable,
    authFailed: payload.counts.authFailed,
    sensorsWarn: payload.counts.sensorsWarn,
    sensorsBad: payload.counts.sensorsBad,
    watts: payload.counts.watts
  }
}

/**
 * The in-memory tail a freshly opened browser is seeded with, plus the write
 * to the archive on disk. Five minutes is enough to draw a live chart while
 * the history query for the real window is still in flight.
 */
export class SeriesLog {
  points: SeriesPoint[] = []

  constructor(private ctx: ModuleContext) {}

  append(payload: MachinesPayload): SeriesPoint {
    const point = pointFrom(payload)
    this.points.push(point)
    const cutoff = point.t - SERIES_WINDOW_MS
    while (this.points.length && this.points[0].t < cutoff) this.points.shift()
    this.ctx.emit('series', point)
    this.ctx.addHistory({ ...point })
    return point
  }

  reset(): void {
    this.points = []
  }
}
