import { describe, expect, it } from 'vitest'
import { parseDcmiWatts, parseSdr, splitReading, type SensorRow } from '../../bmc/main/ipmi'

/**
 * A page of real `ipmitool sdr elist` output: five padded, pipe-separated
 * columns, `name | idx | status | entity | reading`. Every fixture below keeps
 * the firmware's own spacing and wording, because the padding and the discrete
 * ("Presence detected", "Disabled") readings are exactly what the parser has to
 * survive.
 */
const ELIST = `
CPU1 Temp        | 01h | ok  |  3.1 | 45 degrees C
CPU2 Temp        | 02h | ns  |  3.2 | Disabled
System Temp      | 0Ah | ok  |  7.1 | 28 degrees C
FAN1             | 41h | ok  | 29.1 | 3500 RPM
FAN2             | 42h | cr  | 29.2 | 300 RPM
FANA             | 46h | ns  | 29.6 | No Reading
12V              | 30h | ok  |  7.1 | 12.192 Volts
Vcpu1            | 21h | nc  |  3.1 | 1.35 Volts
-12V             | 35h | ok  |  7.1 | -12.096 Volts
PSU1 Power       | 60h | ok  | 10.1 | 148 Watts
Fan Duty         | 68h | ok  | 29.1 | 45 percent
SEL              | 72h | ok  |  7.1 |
PS1 Status       | 74h | ok  | 10.1 | Presence detected
`

/** One line per code IPMI can print in the status column, plus two it cannot. */
const STATUS_ELIST = `
Plain Ok         | 01h | ok  |  3.1 | 40 degrees C
Bare NonCrit     | 02h | nc  |  3.1 | 88 degrees C
Lower NonCrit    | 03h | lnc |  3.1 | 5 degrees C
Upper NonCrit    | 04h | unc |  3.1 | 90 degrees C
Critical         | 05h | cr  |  3.1 | 95 degrees C
Lower Critical   | 06h | lcr |  3.1 | 2 degrees C
Upper Critical   | 07h | ucr |  3.1 | 97 degrees C
NonRecoverable   | 08h | nr  |  3.1 | 110 degrees C
Lower NonRecov   | 09h | lnr |  3.1 | 1 degrees C
Upper NonRecov   | 0Ah | unr |  3.1 | 115 degrees C
No State         | 0Bh | ns  |  3.1 | No Reading
Shouting         | 0Ch | OK  |  3.1 | 41 degrees C
Something New    | 0Dh | wat |  3.1 | 42 degrees C
`

/** What a BMC prints on a sensor it has lost, next to two honest readings. */
const SENTINEL_ELIST = `
FAN3             | 43h | ns  | 29.3 | 65535 RPM
CPU3 Temp        | 03h | ns  |  3.3 | -128 degrees C
Inlet Temp       | 04h | ok  |  7.3 | 250 degrees C
`

function rowNamed(rows: readonly SensorRow[], name: string): SensorRow {
  const row = rows.find((candidate) => candidate.name === name)
  if (!row) throw new Error(`no sensor row named "${name}" in ${rows.map((r) => r.name).join(', ')}`)
  return row
}

function measure(rows: readonly SensorRow[], name: string): { value: number | null; unit: string } {
  const row = rowNamed(rows, name)
  return { value: row.value, unit: row.unit }
}

describe('parseSdr: turning `ipmitool sdr elist` into sensor rows', () => {
  it('keeps one row per sensor, in the order the firmware listed them, with the padding stripped off the name', () => {
    const rows = parseSdr(ELIST)

    expect(rows.map((row) => row.name)).toEqual([
      'CPU1 Temp',
      'CPU2 Temp',
      'System Temp',
      'FAN1',
      'FAN2',
      'FANA',
      '12V',
      'Vcpu1',
      '-12V',
      'PSU1 Power',
      'Fan Duty',
      'SEL',
      'PS1 Status'
    ])
  })

  it('maps every threshold code IPMI can print onto one of the four statuses the UI knows, case-insensitively', () => {
    const statuses = new Map(parseSdr(STATUS_ELIST).map((row) => [row.name, row.status]))

    expect(Object.fromEntries(statuses)).toEqual({
      'Plain Ok': 'ok',
      'Bare NonCrit': 'warn',
      'Lower NonCrit': 'warn',
      'Upper NonCrit': 'warn',
      Critical: 'bad',
      'Lower Critical': 'bad',
      'Upper Critical': 'bad',
      NonRecoverable: 'bad',
      'Lower NonRecov': 'bad',
      'Upper NonRecov': 'bad',
      // `ns` is "no state" - reported, but never treated as a fault.
      'No State': 'unknown',
      Shouting: 'ok',
      'Something New': 'unknown'
    })
  })

  it('splits the number and the unit out of a threshold reading and normalises the unit for display', () => {
    const rows = parseSdr(ELIST)

    expect(measure(rows, 'CPU1 Temp')).toEqual({ value: 45, unit: '°C' })
    expect(measure(rows, 'FAN1')).toEqual({ value: 3500, unit: 'RPM' })
    expect(measure(rows, 'Vcpu1')).toEqual({ value: 1.35, unit: 'V' })
    expect(measure(rows, '12V')).toEqual({ value: 12.192, unit: 'V' })
    expect(measure(rows, 'PSU1 Power')).toEqual({ value: 148, unit: 'W' })
    expect(measure(rows, 'Fan Duty')).toEqual({ value: 45, unit: '%' })
  })

  it('keeps a negative rail voltage, which is a real reading and not a sensor failure', () => {
    expect(measure(parseSdr(ELIST), '-12V')).toEqual({ value: -12.096, unit: 'V' })
  })

  it('leaves value null and unit empty for a sensor with nothing to report, and still shows its words', () => {
    const rows = parseSdr(ELIST)

    expect(rowNamed(rows, 'FANA')).toMatchObject({ reading: 'No Reading', value: null, unit: '' })
    expect(rowNamed(rows, 'CPU2 Temp')).toMatchObject({ reading: 'Disabled', value: null, unit: '' })
    expect(rowNamed(rows, 'PS1 Status')).toMatchObject({
      reading: 'Presence detected',
      value: null,
      unit: ''
    })
  })

  it('substitutes "No reading" when the reading column is empty, so no row ever renders as a blank cell', () => {
    const rows = parseSdr(ELIST)

    expect(rowNamed(rows, 'SEL')).toMatchObject({ reading: 'No reading', value: null, unit: '' })
    expect(rows.every((row) => row.reading.trim().length > 0)).toBe(true)
  })

  it('drops a temperature the hardware cannot be reporting while keeping the text the firmware printed', () => {
    const rows = parseSdr(SENTINEL_ELIST)

    expect(rowNamed(rows, 'CPU3 Temp')).toMatchObject({
      reading: '-128 degrees C',
      value: null,
      unit: ''
    })
    // 250 °C is the top of the plausible band, not past it: a hot inlet reading
    // must not disappear because it sits exactly on the limit.
    expect(measure(rows, 'Inlet Temp')).toEqual({ value: 250, unit: '°C' })
  })

  it('drops the 65535 RPM sentinel a failed fan sensor reports while keeping the text the firmware printed', () => {
    const rows = parseSdr(SENTINEL_ELIST)

    // 0xFFFF is what a BMC prints for a fan it has lost; charted as a number it
    // flattens every real fan on the machine to nothing.
    expect(rowNamed(rows, 'FAN3')).toMatchObject({ reading: '65535 RPM', value: null, unit: '' })
  })
})

describe('splitReading: which readings become numbers', () => {
  it('recognises the unit spellings ipmitool uses and rewrites them for display', () => {
    expect(splitReading('45 degrees C')).toEqual({ value: 45, unit: '°C' })
    expect(splitReading('113 degrees F')).toEqual({ value: 113, unit: '°F' })
    expect(splitReading('3500 RPM')).toEqual({ value: 3500, unit: 'RPM' })
    expect(splitReading('1.35 Volts')).toEqual({ value: 1.35, unit: 'V' })
    expect(splitReading('0.6 Amps')).toEqual({ value: 0.6, unit: 'A' })
    expect(splitReading('148 Watts')).toEqual({ value: 148, unit: 'W' })
    expect(splitReading('45 percent')).toEqual({ value: 45, unit: '%' })
    expect(splitReading('45 %')).toEqual({ value: 45, unit: '%' })
  })

  it('accepts a signed reading, so a -12 V rail and a +5 V rail both keep their number', () => {
    expect(splitReading('-12.096 Volts')).toEqual({ value: -12.096, unit: 'V' })
    expect(splitReading('+5.02 Volts')).toEqual({ value: 5.02, unit: 'V' })
  })

  it('never rejects a voltage for its size or sign, because the plausible range for a rail is unknowable here', () => {
    expect(splitReading('-128 Volts')).toEqual({ value: -128, unit: 'V' })
    expect(splitReading('65535 Volts')).toEqual({ value: 65535, unit: 'V' })
  })

  it('bounds each kind of reading by what the hardware could physically report', () => {
    expect(splitReading('250 degrees C')).toEqual({ value: 250, unit: '°C' })
    expect(splitReading('251 degrees C')).toEqual({ value: null, unit: '' })
    expect(splitReading('-59 degrees C')).toEqual({ value: -59, unit: '°C' })
    expect(splitReading('-60 degrees C')).toEqual({ value: null, unit: '' })
    expect(splitReading('0 RPM')).toEqual({ value: 0, unit: 'RPM' })
    expect(splitReading('-1 RPM')).toEqual({ value: null, unit: '' })
    expect(splitReading('100 percent')).toEqual({ value: 100, unit: '%' })
    expect(splitReading('120 percent')).toEqual({ value: null, unit: '' })
  })

  it('rejects the sentinel a failed fan sensor prints, which is what the gate exists for', () => {
    expect(splitReading('65535 RPM')).toEqual({ value: null, unit: '' })
  })

  it('takes no number at all from a reading that has none', () => {
    expect(splitReading('No Reading')).toEqual({ value: null, unit: '' })
    expect(splitReading('Drive Present')).toEqual({ value: null, unit: '' })
    expect(splitReading('')).toEqual({ value: null, unit: '' })
  })

  it('does not mistake prose that opens with a number for a measurement in some unknown unit', () => {
    expect(splitReading('0 Unspecified error')).toEqual({ value: null, unit: '' })
    expect(splitReading('2 devices present')).toEqual({ value: null, unit: '' })
  })

  it('does not read a hex event status as the number zero in a unit called "x0100"', () => {
    // Discrete sensors report a bitfield, not a measurement; a 0 charted next to
    // real readings is worse than no number at all.
    expect(splitReading('0x0100')).toEqual({ value: null, unit: '' })
    expect(splitReading('0x0000')).toEqual({ value: null, unit: '' })
  })

  it('keeps a number whose single trailing word is a unit this table has not listed', () => {
    // Deliberate leniency: an unknown short unit is passed through verbatim
    // rather than costing the row its number.
    expect(splitReading('1200 Bogomips')).toEqual({ value: 1200, unit: 'Bogomips' })
    expect(splitReading('42')).toEqual({ value: 42, unit: '' })
  })
})

describe('parseSdr: row identity', () => {
  it('disambiguates repeated sensor names with a counted suffix rather than by leaning on the firmware id', () => {
    const rows = parseSdr(`
FAN1             | 41h | ok  | 29.1 | 3500 RPM
FAN1             | 42h | ok  | 29.2 | 3600 RPM
FAN1             | 43h | ok  | 29.3 | 3400 RPM
`)

    expect(rows.map((row) => row.name)).toEqual(['FAN1', 'FAN1 #2', 'FAN1 #3'])
    expect(rows.map((row) => row.value)).toEqual([3500, 3600, 3400])
  })

  it('gives every row a unique idx even when a real SDR id is already hyphenated', () => {
    // The previous version disambiguated by suffixing the id, so the synthesised
    // `3-2` for the second `Temp` collided with the genuine `3-2` below it and
    // the two rows shared a table key.
    const rows = parseSdr(`
Temp             | 3   | ok  |  3.1 | 40 degrees C
Temp             | 3-2 | ok  |  3.2 | 41 degrees C
`)

    expect(rows.map((row) => row.idx)).toEqual(['3:Temp', '3-2:Temp #2'])
    expect(new Set(rows.map((row) => row.idx)).size).toBe(rows.length)
  })

  it('keeps every idx unique across a whole page of output', () => {
    const rows = parseSdr(ELIST)

    expect(new Set(rows.map((row) => row.idx)).size).toBe(rows.length)
    expect(rows.every((row) => row.idx.length > 0)).toBe(true)
  })
})

describe('parseSdr: lines that are not sensor rows', () => {
  it('skips blank lines, prose, and any line with fewer than four columns', () => {
    const rows = parseSdr(`

Sensor ID              : CPU1 Temp (0x1)
CPU1 Temp | 45 degrees C | ok
                 | 41h | ok  | 29.1 | 3500 RPM
FAN1             | 41h | ok  | 29.1 | 3500 RPM
`)

    expect(rows.map((row) => row.name)).toEqual(['FAN1'])
  })

  it('reads a truncated four-column line rather than dropping the sensor', () => {
    // Tolerance for output that lost its reading column: the row is still worth
    // showing, and its status still comes from column three.
    const rows = parseSdr('Chassis Intru    | 73h | ok  | Present\n')

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: 'Chassis Intru', status: 'ok', reading: 'Present' })
  })

  it('keeps a reading that itself contains a pipe', () => {
    const rows = parseSdr('Power Supply     | 74h | ok  | 10.1 | Presence detected | Failure detected\n')

    expect(rows[0].reading).toBe('Presence detected | Failure detected')
  })
})

/* ------------------------------------------------------------------------ */
/* parseDcmiWatts()                                                         */
/* ------------------------------------------------------------------------ */

/** `ipmitool dcmi power reading` on a board that implements DCMI. */
const DCMI_READING = [
    '    Instantaneous power reading:                   142 Watts',
    '    Minimum during sampling period:                 90 Watts',
    '    Maximum during sampling period:                210 Watts',
    '    Average power reading over sample period:      150 Watts',
    '    IPMI timestamp:                           Thu Aug 29 12:00:00 2026',
    '    Sampling period:                          00000000 Seconds.',
    '    Power reading state is:                   deactivated',
    ''
].join('\n')

describe('parseDcmiWatts(): what the chassis is drawing', () => {
    it('takes the instantaneous reading and nothing else', () => {
        // The minimum, maximum and average are all "over sample period", and
        // controllers routinely report that period as zero - a number whose
        // window is unknown cannot be compared between two machines, so only
        // the instantaneous figure is taken even though three others are there.
        expect(parseDcmiWatts(DCMI_READING)).toBe(142)
    })

    it('answers null when the controller replied without a reading', () => {
        expect(parseDcmiWatts('')).toBeNull()
        expect(parseDcmiWatts('Sampling period: 00000000 Seconds.')).toBeNull()
    })

    it('rejects a zero reading, because a board with the command and no sensor answers zero forever', () => {
        // Charted as a real figure this would say the rack draws nothing,
        // which is worse than the chart having no line at all.
        expect(parseDcmiWatts('Instantaneous power reading: 0 Watts')).toBeNull()
    })

    it('rejects a figure no chassis could really be drawing', () => {
        expect(parseDcmiWatts('Instantaneous power reading: 999999 Watts')).toBeNull()
    })

    it('rounds a fractional reading, since a watt is the smallest unit worth charting', () => {
        expect(parseDcmiWatts('Instantaneous power reading: 142.6 Watts')).toBe(143)
    })

    it('reads the reading whatever case the firmware used for it', () => {
        expect(parseDcmiWatts('INSTANTANEOUS POWER READING : 88 WATTS')).toBe(88)
    })
})
