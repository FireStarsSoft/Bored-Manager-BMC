import { splitSections } from '@shared/shell'

export type PowerState = 'on' | 'off'
export type ItemStatus = 'ok' | 'warn' | 'bad' | 'unknown'

export interface SensorRow {
  idx: string
  name: string
  /** The reading exactly as the firmware worded it, always present. */
  reading: string
  /** The number inside `reading` when there is one and it is plausible. */
  value: number | null
  /** The unit that went with `value`, normalised for display. */
  unit: string
  status: ItemStatus
}

export interface SelRow {
  idx: string
  seq: number
  when: string
  sensor: string
  event: string
}

export interface InspectFacts {
  firmware: string
  ipmiVersion: string
  manufacturer: string
  product: string
  serial: string
  mac: string
}

export interface McInfo {
  firmware: string
  manufacturer: string
  product: string
}

export function parsePowerStatus(text: string): PowerState | null {
  const match = text.match(/Chassis\s+Power\s+is\s+(on|off)\b/i)
  return match ? (match[1].toLowerCase() as PowerState) : null
}

/**
 * IPMI's own threshold vocabulary, which is already a severity - the firmware
 * has compared the reading against the thresholds it was configured with, and
 * this module has no business second-guessing that with limits of its own.
 *
 * `nc` is "non-critical", `cr` "critical", `nr` "non-recoverable"; the `l`/`u`
 * prefixes are the lower and upper side of the same band. `ns` ("no state")
 * and anything unrecognised is `unknown`, which is reported and never folded
 * into a machine's health - one unreadable row should not grey a good card.
 */
function sensorStatus(raw: string): ItemStatus {
  const code = raw.trim().toLowerCase()
  if (code === 'ok') return 'ok'
  if (code === 'nc' || code === 'lnc' || code === 'unc') return 'warn'
  if (code === 'cr' || code === 'nr' || /^(?:lcr|ucr|lnr|unr)$/.test(code)) return 'bad'
  return 'unknown'
}

/** What a unit says the reading is, so an impossible number can be spotted. */
type SensorKind = 'temp' | 'fan' | 'volt' | 'current' | 'power' | 'percent' | 'other'

const UNITS: ReadonlyArray<{ match: RegExp; unit: string; kind: SensorKind }> = [
  { match: /^degrees?\s*c$/i, unit: '°C', kind: 'temp' },
  { match: /^degrees?\s*f$/i, unit: '°F', kind: 'temp' },
  { match: /^rpm$/i, unit: 'RPM', kind: 'fan' },
  { match: /^volts?$/i, unit: 'V', kind: 'volt' },
  { match: /^amps?$/i, unit: 'A', kind: 'current' },
  { match: /^watts?$/i, unit: 'W', kind: 'power' },
  { match: /^percent$/i, unit: '%', kind: 'percent' },
  { match: /^%$/, unit: '%', kind: 'percent' }
]

/**
 * What a controller prints for a reading it has lost: the top of the 16-bit
 * range rather than an omitted row. The bands below stop under it instead of
 * at a round number, which would let the sentinel through as a real figure.
 */
const LOST_READING = 65_534

/**
 * Drop a number the hardware cannot really be reporting, keeping the raw text.
 *
 * A BMC that has lost a sensor often prints its sentinel rather than omitting
 * the row - 65535 RPM, -128 °C - and a value like that poisons a chart or an
 * "is this hot" comparison far more than a missing one does. Voltages pass
 * through unchecked because a -12 V rail is real.
 */
function plausible(kind: SensorKind, value: number): boolean {
  if (!Number.isFinite(value)) return false
  if (kind === 'temp') return value > -60 && value <= 250
  if (kind === 'fan') return value >= 0 && value < LOST_READING
  if (kind === 'current' || kind === 'power') return value >= 0 && value < LOST_READING
  if (kind === 'percent') return value >= 0 && value <= 100
  return true
}

/**
 * Pull the number and unit out of a reading like `45 degrees C` or `3500 RPM`.
 *
 * Everything the firmware wrote is kept in `reading` regardless; this only
 * adds a sortable number when the shape is unambiguous, so `No Reading`,
 * `0x0100` and `Drive Present` simply have none.
 */
export function splitReading(reading: string): { value: number | null; unit: string } {
  const text = reading.trim()
  // A discrete sensor reports a bitfield, not a measurement. Left alone, the
  // leading digits of `0x0100` parse as the number zero with `x0100` for a
  // unit, and every chassis-intrusion and PSU-status row would then be
  // charted and sorted as a real zero beside genuine readings.
  if (/^0[xX][0-9a-fA-F]+$/.test(text)) return { value: null, unit: '' }

  const match = text.match(/^([-+]?\d+(?:\.\d+)?)\s*(.*)$/)
  if (!match) return { value: null, unit: '' }

  const parsed = Number(match[1])
  const rest = match[2].trim()
  const known = UNITS.find((entry) => entry.match.test(rest))
  const kind: SensorKind = known?.kind ?? 'other'
  if (!plausible(kind, parsed)) return { value: null, unit: '' }
  if (known) return { value: parsed, unit: known.unit }
  // An unrecognised trailing word is a unit this table does not know, not a
  // reason to throw the number away - unless it is a whole sentence, in which
  // case the "number" was the start of prose rather than a measurement, or it
  // carries digits of its own, in which case the number was never one.
  if (rest && (!/^[^\s]{1,12}$/.test(rest) || /\d/.test(rest))) return { value: null, unit: '' }
  return { value: parsed, unit: rest }
}

/**
 * Parse the stable pipe-separated shape produced by `ipmitool sdr elist`:
 * `name | idx | status | entity | reading`.
 *
 * Duplicate names are disambiguated on the name rather than on the hex id the
 * previous version suffixed, because `3-2` is a legitimate SDR id and a
 * synthesised one collided with it.
 */
export function parseSdr(text: string): SensorRow[] {
  const rows: SensorRow[] = []
  const seen = new Set<string>()

  for (const line of text.split('\n')) {
    const parts = line.split('|').map((part) => part.trim())
    if (parts.length < 4 || !parts[0]) continue

    const rawName = parts[0]
    let name = rawName
    let suffix = 1
    while (seen.has(name)) {
      suffix += 1
      name = `${rawName} #${suffix}`
    }
    seen.add(name)

    const reading =
      (parts.length >= 5 ? parts.slice(4) : parts.slice(3)).join(' | ') || 'No reading'
    const { value, unit } = splitReading(reading)

    rows.push({
      // The firmware's own id when it gave one, kept unique by the name that
      // now qualifies it, so a table's rowKey is stable across polls.
      idx: parts[1] ? `${parts[1]}:${name}` : name,
      name,
      reading,
      value,
      unit,
      status: sensorStatus(parts[2] ?? '')
    })
  }

  return rows
}

/** Parse the latest entries returned by `ipmitool sel elist last <n>`. */
export function parseSel(text: string): SelRow[] {
  const rows: SelRow[] = []
  const seen = new Set<string>()

  for (const line of text.split('\n')) {
    const parts = line.split('|').map((part) => part.trim())
    if (parts.length < 5 || !parts[0]) continue

    const base = parts[0]
    let idx = base
    let suffix = 1
    while (seen.has(idx)) {
      suffix += 1
      idx = `${base}-${suffix}`
    }
    seen.add(idx)

    // An entry recorded before the BMC's clock was set carries a
    // seconds-since-init counter where the time of day goes. ipmitool usually
    // gives that counter its own column, so the row has the same shape as a
    // timestamped one and only the marker distinguishes it; some versions
    // collapse the two into one field. Either way the counter is dropped
    // rather than joined into `when`, because the pages label that column as
    // the BMC's clock and an uptime figure is not a reading of it.
    const preInit = /pre-?init|invalid time/i.test(parts[1] ?? '')
    const collapsed = preInit && parts.length === 5
    const date = parts[1] ?? ''
    const time = preInit ? '' : parts[2] ?? ''
    const sensor = collapsed ? parts[2] ?? '' : parts[3] ?? ''
    const eventAt = collapsed ? 3 : 4
    const numericId = Number.parseInt(base, 16)
    rows.push({
      idx,
      seq: Number.isFinite(numericId) ? numericId : rows.length,
      when: [date, time].filter(Boolean).join(' '),
      sensor,
      event: parts.slice(eventAt).filter(Boolean).join(' — ')
    })
  }

  return rows
}

/** The thresholds a controller was configured with, for one sensor. */
export interface SensorThresholds {
  /** Lower non-critical, critical, non-recoverable. */
  lnc: number | null
  lcr: number | null
  lnr: number | null
  /** And the upper three. */
  unc: number | null
  ucr: number | null
  unr: number | null
}


/**
 * The thresholds behind each sensor, from `ipmitool sensor list`.
 *
 * `sdr elist` says whether a reading is inside its thresholds; this says what
 * they are. Both are worth having, and neither replaces the other: the status
 * word is the firmware's own verdict and is what a card is coloured by, while
 * the numbers are what turns "ok" into "ok, and eight degrees from not being".
 *
 * The output is pipe-separated, one row per sensor:
 * `name | reading | unit | status | lnr | lcr | lnc | unc | ucr | unr`
 * with `na` wherever a controller has no threshold configured, which is most
 * of them on most boards.
 */
export function parseSensorThresholds(text: string): Map<string, SensorThresholds> {
  const out = new Map<string, SensorThresholds>()
  for (const line of text.split('\n')) {
    const parts = line.split('|').map((part) => part.trim())
    if (parts.length < 10 || !parts[0]) continue
    const numbers = parts.slice(4, 10).map((value) => {
      const parsed = Number(value)
      return value && value.toLowerCase() !== 'na' && Number.isFinite(parsed) ? parsed : null
    })
    const [lnr, lcr, lnc, unc, ucr, unr] = numbers
    // A row where the controller has configured nothing is not worth keeping:
    // it would show as six empty columns beside a reading.
    if (numbers.every((value) => value == null)) continue
    out.set(parts[0], { lnr, lcr, lnc, unc, ucr, unr })
  }
  return out
}

/**
 * How much room is left before the nearest threshold that matters.
 *
 * Null when there is no threshold on the side the reading is heading, which is
 * the ordinary case - a controller usually configures an upper critical for a
 * temperature and nothing at all for a voltage.
 */
export function headroom(value: number, thresholds: SensorThresholds): number | null {
  const above = [thresholds.unc, thresholds.ucr, thresholds.unr]
    .filter((limit): limit is number => limit != null && limit > value)
    .sort((a, b) => a - b)[0]
  const below = [thresholds.lnc, thresholds.lcr, thresholds.lnr]
    .filter((limit): limit is number => limit != null && limit < value)
    .sort((a, b) => b - a)[0]
  const gaps: number[] = []
  if (above != null) gaps.push(above - value)
  if (below != null) gaps.push(value - below)
  if (gaps.length === 0) return null
  return Math.round(Math.min(...gaps) * 100) / 100
}

/**
 * The BMC's own clock, from `ipmitool sel time get`, as epoch milliseconds.
 *
 * The controller prints a local time with no zone on it - `08/30/2026
 * 09:14:22` - because it does not know its own zone. So it is read as if it
 * were the reading machine's local time, which is the only interpretation that
 * makes the usual case (both set from the same NTP source, in the same place)
 * come out as no drift at all. It also means a genuine zone difference reads
 * as hours of drift, which is worth saying out loud: for a log nobody can
 * correlate, a whole-hour offset is the problem, not a rounding of it.
 */
export function parseSelTime(text: string): number | null {
  const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/)
  if (!match) return null
  const [, month, day, year, hour, minute, second] = match.map(Number)
  const at = new Date(year, month - 1, day, hour, minute, second)
  const ms = at.getTime()
  if (!Number.isFinite(ms)) return null
  // A controller that has never had its clock set answers with its epoch,
  // usually 1970 or 2000. That is not drift, it is "never set", and the two
  // deserve different sentences.
  if (year < 2001) return null
  return ms
}

/**
 * The instantaneous draw from `ipmitool dcmi power reading`, in watts.
 *
 * Only the instantaneous figure is taken. The same output carries a minimum, a
 * maximum and an average "over sample period", and every one of those is a
 * window whose length the controller chooses and often reports as zero - a
 * number that cannot be compared between two machines is worse than no number.
 *
 * Null when the controller answered without one, which is the ordinary case:
 * DCMI is optional and plenty of boards do not implement it.
 */
export function parseDcmiWatts(text: string): number | null {
  const match = text.match(/Instantaneous power reading\s*:\s*([\d.]+)\s*Watts/i)
  if (!match) return null
  const watts = Number(match[1])
  // A controller that has the command and no sensor behind it answers zero
  // forever; charting that as a real reading would say the rack draws nothing.
  if (!Number.isFinite(watts) || watts <= 0 || watts > 100_000) return null
  return Math.round(watts)
}

function keyValues(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([^:]+?)\s*:\s*(.*?)\s*$/)
    if (!match) continue
    const key = match[1].trim()
    const value = match[2].trim()
    if (key && value && !values.has(key)) values.set(key, value)
  }
  return values
}

function first(values: Map<string, string>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = values.get(key)
    if (value) return value
  }
  return ''
}

export function parseMcInfo(text: string): McInfo {
  const values = keyValues(text)
  return {
    firmware: first(values, ['Firmware Revision']),
    manufacturer: first(values, ['Manufacturer Name']),
    product: first(values, ['Product Name', 'Product ID'])
  }
}

/** Fold the MC, FRU, and LAN sections from one batched inspection command. */
export function parseInspect(text: string): InspectFacts {
  const sections = splitSections(text)
  const mc = keyValues(sections.get('MC') ?? '')
  const fru = keyValues(sections.get('FRU') ?? '')
  const lan = keyValues(sections.get('LAN') ?? '')

  return {
    firmware: first(mc, ['Firmware Revision']),
    ipmiVersion: first(mc, ['IPMI Version']),
    manufacturer:
      first(mc, ['Manufacturer Name']) ||
      first(fru, ['Product Manufacturer', 'Board Mfg', 'Board Manufacturer']),
    product: first(fru, ['Board Product', 'Product Name']),
    serial: first(fru, ['Board Serial', 'Product Serial']),
    mac: first(lan, ['MAC Address'])
  }
}
