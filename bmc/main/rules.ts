/**
 * The handful of numbers that change how the sweep behaves.
 *
 * They were constants until now, which was fine while every rack looked like
 * the one this module was written against. Four machines swept at once is
 * generous for four BMCs and slow for forty; reading sensors every third
 * sweep is right for a slow interval of a minute and wasteful for one of ten.
 *
 * Empty means "leave this one alone" rather than "set it to zero" - which is
 * also why the fields are text rather than number inputs: an empty number
 * field arrives as an empty string that a spinner cannot distinguish from
 * somebody deliberately typing 0.
 */
import {
  createCheckSession,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import {
  DEFAULT_SETTINGS,
  SETTING_LIMITS,
  defaultSettings,
  type BmcSettings,
  type ConfigStore
} from './store'

const FIELDS: ReadonlyArray<{ key: keyof BmcSettings; label: string; unit: string }> = [
  { key: 'sweepConcurrency', label: 'Machines swept at once', unit: '' },
  { key: 'sensorEverySweeps', label: 'Read sensors every', unit: 'sweeps' },
  { key: 'selFetchCount', label: 'Event log entries fetched', unit: 'entries' },
  { key: 'identifySeconds', label: 'Identify blink default', unit: 'seconds' }
]

export interface EffectiveRules extends Record<string, unknown> {
  sweepConcurrency: number
  sensorEverySweeps: number
  selFetchCount: number
  identifySeconds: number
  /** A sentence for the one value whose meaning is not obvious from its number. */
  sensorNote: string
}

/** `1st`, `2nd`, `3rd`, `4th` - including the teens, which all take `th`. */
function ordinal(value: number): string {
  const tens = value % 100
  if (tens >= 11 && tens <= 13) return `${value}th`
  const ones = value % 10
  return `${value}${ones === 1 ? 'st' : ones === 2 ? 'nd' : ones === 3 ? 'rd' : 'th'}`
}

function sensorNote(settings: BmcSettings): string {
  if (settings.sensorEverySweeps === 0) {
    return 'Sensors are not read during sweeps - machine health comes from the chassis power state alone.'
  }
  if (settings.sensorEverySweeps === 1) return 'Sensors are read on every sweep.'
  return `Sensors are read on every ${ordinal(settings.sensorEverySweeps)} sweep.`
}

export class RulesEditor {
  private session = createCheckSession<BmcSettings>()

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore,
    private onApplied: () => void
  ) {}

  effective(): EffectiveRules {
    const settings = this.store.settings()
    return { ...settings, sensorNote: sensorNote(settings) }
  }

  check(raw: unknown): ModuleCheckReport {
    const values = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
    const current = this.store.settings()
    const next: BmcSettings = { ...current }
    const findings: ModuleCheckFinding[] = []

    for (const field of FIELDS) {
      const entered = values[field.key]
      const asText = typeof entered === 'string' ? entered.trim() : entered == null ? '' : String(entered)
      if (asText === '') continue

      const parsed = Number(asText)
      const limits = SETTING_LIMITS[field.key]
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        findings.push({
          level: 'error',
          label: `${field.label}: "${asText}" is not a whole number`
        })
        continue
      }
      if (parsed < limits.min || parsed > limits.max) {
        findings.push({
          level: 'error',
          label: `${field.label} has to be between ${limits.min} and ${limits.max}`,
          detail: `You entered ${parsed}.`
        })
        continue
      }
      next[field.key] = parsed
    }

    if (hasBlockingFinding(findings)) return { ok: false, findings }

    const changes = FIELDS.filter((field) => next[field.key] !== current[field.key])
    if (changes.length === 0) {
      findings.push({ level: 'pass', label: 'Nothing would change', detail: 'Every field is empty or already set to that value.' })
    }
    for (const field of changes) {
      findings.unshift({
        level: 'pass',
        label: `${field.label}: ${current[field.key]} becomes ${next[field.key]}${field.unit ? ` ${field.unit}` : ''}`
      })
    }
    if (next.sensorEverySweeps === 0 && current.sensorEverySweeps !== 0) {
      findings.push({
        level: 'warning',
        label: 'Sensor health will be switched off',
        detail: 'Cards go back to reporting the chassis power state only, so a machine with a failed fan will read as healthy.'
      })
    }
    if (next.sweepConcurrency > current.sweepConcurrency) {
      findings.push({
        level: 'warning',
        label: 'The connected machine will run more ipmitool processes at once',
        detail: `Up to ${next.sweepConcurrency} at a time during a sweep.`
      })
    }

    return { ok: true, token: this.session.issue(values, next), findings }
  }

  apply(raw: unknown): OkResult {
    const payload =
      typeof raw === 'object' && raw !== null ? (raw as { token?: unknown; values?: unknown }) : {}
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) {
      return { ok: false, error: 'that check has expired or the form changed - check again' }
    }
    this.write(taken.payload)
    return { ok: true }
  }

  reset(): OkResult {
    this.write(defaultSettings())
    return { ok: true, data: 'Every rule is back to its default' }
  }

  /**
   * Accepts the value either bare or wrapped.
   *
   * A `form` block submits its fields positionally, so the renderer calls this
   * `hintsSet(true)` - not `hintsSet({ hintsOn: true })`, which is the
   * `checkForm` convention. Reading only the wrapped shape made the switch a
   * one-way door: every save resolved to `false`, so hints could be turned off
   * and never back on.
   */
  hintsSet(raw: unknown): OkResult {
    const values =
      typeof raw === 'object' && raw !== null
        ? (raw as Record<string, unknown>)
        : { hintsOn: raw }
    const hintsOn = values.hintsOn === true || values.hintsOn === 'true'
    this.store.update((config) => {
      config.hintsOn = hintsOn
    })
    this.onApplied()
    return { ok: true }
  }

  clear(): void {
    this.session.clear()
  }

  private write(settings: BmcSettings): void {
    this.store.update((config) => {
      config.settings = { ...settings }
    })
    this.ctx.log(
      `bmc: rules set - ${FIELDS.map((field) => `${field.key} ${settings[field.key]}`).join(', ')}`
    )
    this.onApplied()
  }
}

/** The defaults, for a settings page that wants to show them as placeholders. */
export const RULE_DEFAULTS = DEFAULT_SETTINGS
