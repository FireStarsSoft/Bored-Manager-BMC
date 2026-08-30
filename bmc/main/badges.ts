/**
 * One colour per meaning, for every chip this module renders.
 *
 * Adapted from the OpenWRT module rather than shared, because a module may
 * only import its own files and `@shared/*`. The point is not decoration: a
 * critical sensor is the same red on a fleet card, in the sensor table and in
 * the Overview widget, so a colour means one thing everywhere and a rack can
 * be scanned without being read.
 *
 * The hex is deliberate. Chips are data, not theme tokens - they travel
 * through a stream and have to survive a theme switch - so this picks from the
 * same twelve swatches the app's own colour field offers
 * (`FORM_COLOR_SWATCHES`).
 */
import type { ValueBadge } from '@shared/module-ui'

export const BADGE = {
  /** Reading normally, or otherwise nothing to do. */
  good: '#22c55e',
  /** Being asked right now, and expected to answer. */
  busy: '#3b82f6',
  /** Inside a non-critical threshold, or refusing the saved credentials. */
  warn: '#f59e0b',
  /** Past a critical threshold, or not answering at all. */
  bad: '#ef4444',
  /** Configured here and not reporting - a different failure from `bad`. */
  missing: '#f97316'
} as const

/** The vocabulary `statusCards` tints its rows and chips with. */
export type StatusTone = 'ok' | 'warn' | 'bad' | 'unknown'

export interface StatusChip {
  label: string
  status: StatusTone
  /** Set on anything not `ok`, so a card's "pinned only" switch shows faults. */
  pinned: boolean
}

/**
 * Every status word this module puts in front of a user, and nothing else. A
 * word that is not here renders as a neutral chip, which is the right answer
 * for `parked`, `unknown` and `not checked` - states that are neither healthy
 * nor wrong - and a visible bug for anything that was meant to carry a colour.
 */
const STATUS_COLOR: Readonly<Record<string, string>> = {
  ok: BADGE.good,
  on: BADGE.good,
  healthy: BADGE.good,

  checking: BADGE.busy,

  warn: BADGE.warn,
  warning: BADGE.warn,
  auth: BADGE.warn,

  bad: BADGE.bad,
  critical: BADGE.bad,
  unreachable: BADGE.bad,
  timeout: BADGE.bad,
  refused: BADGE.bad,
  dns: BADGE.bad,

  missing: BADGE.missing
}

/** One chip. Pass a colour for a word whose meaning is local to the caller. */
export function badge(label: string, color?: string): ValueBadge {
  return color ? { label, color } : { label }
}

/** The chip for a status word; empty for an empty status, so a cell stays blank. */
export function statusBadges(status: unknown): ValueBadge[] {
  const label = typeof status === 'string' ? status.trim() : ''
  if (!label) return []
  return [badge(label, STATUS_COLOR[label])]
}

export interface BadgeCount {
  label: string
  count: number
  color?: string
}

/**
 * `3 ok`, `1 critical`. A count of zero is left out rather than printed as
 * `0 critical`: the chips exist to say what is worth looking at, and a row of
 * zeroes says nothing while costing the width that the non-zero ones need.
 */
export function countBadges(parts: readonly BadgeCount[]): ValueBadge[] {
  return parts
    .filter((part) => part.count > 0)
    .map((part) => badge(`${part.count} ${part.label}`, part.color))
}

/** The same table read as a tone, for the blocks that tint rather than colour. */
export function statusTone(status: unknown): StatusTone {
  const color = typeof status === 'string' ? STATUS_COLOR[status] : undefined
  if (color === BADGE.good) return 'ok'
  if (color === BADGE.bad || color === BADGE.missing) return 'bad'
  if (color === BADGE.warn) return 'warn'
  return 'unknown'
}

/** A `statusCards` chip, pinned whenever it is not the healthy case. */
export function chip(label: string, status: StatusTone): StatusChip {
  return { label, status, pinned: status !== 'ok' }
}
