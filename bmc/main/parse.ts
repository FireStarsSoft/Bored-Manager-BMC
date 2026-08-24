import { splitSections } from '@shared/shell'

export type IpmiFailure = 'unreachable' | 'auth' | 'error'
export type PowerState = 'on' | 'off'
export type ItemStatus = 'ok' | 'warn' | 'bad' | 'unknown'

export interface SensorRow {
  idx: string
  name: string
  reading: string
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

/** Turn the messages emitted by common ipmitool releases into stable UI states. */
export function classifyIpmiFailure(message: string): IpmiFailure {
  if (/RAKP 2|invalid user name|Unauthorized|password|privilege|authentication/i.test(message)) {
    return 'auth'
  }
  if (/Unable to establish|timed?\s*out|Address lookup .* failed|No route to host|Network is unreachable/i.test(message)) {
    return 'unreachable'
  }
  return 'error'
}

export function parsePowerStatus(text: string): PowerState | null {
  const match = text.match(/Chassis\s+Power\s+is\s+(on|off)\b/i)
  return match ? (match[1].toLowerCase() as PowerState) : null
}

function sensorStatus(raw: string): ItemStatus {
  const code = raw.trim().toLowerCase()
  if (code === 'ok') return 'ok'
  if (code === 'nc' || code === 'lnc' || code === 'unc') return 'warn'
  if (code === 'cr' || code === 'nr' || /^(?:lcr|ucr|lnr|unr)$/.test(code)) return 'bad'
  return 'unknown'
}

/** Parse the stable pipe-separated shape produced by `ipmitool sdr elist`. */
export function parseSdr(text: string): SensorRow[] {
  const rows: SensorRow[] = []
  const seen = new Set<string>()

  for (const line of text.split('\n')) {
    const parts = line.split('|').map((part) => part.trim())
    if (parts.length < 4 || !parts[0]) continue

    const base = parts[1] || String(rows.length + 1)
    let idx = base
    let suffix = 1
    while (seen.has(idx)) {
      suffix += 1
      idx = `${base}-${suffix}`
    }
    seen.add(idx)

    rows.push({
      idx,
      name: parts[0],
      status: sensorStatus(parts[2] ?? ''),
      reading: (parts.length >= 5 ? parts.slice(4) : parts.slice(3)).join(' | ') || 'No reading'
    })
  }

  return rows
}

/** Parse the latest entries returned by `ipmitool sel elist last 100`. */
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

    const preInit = parts.length === 5 && /pre-?init|invalid time/i.test(parts[1] ?? '')
    const date = parts[1] ?? ''
    const time = preInit ? '' : parts[2] ?? ''
    const sensor = preInit ? parts[2] ?? '' : parts[3] ?? ''
    const eventAt = preInit ? 3 : 4
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
