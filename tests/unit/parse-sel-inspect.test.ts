import { describe, expect, it } from 'vitest'
import {
  parseInspect,
  parseMcInfo,
  parsePowerStatus,
  parseSel,
  parseSelTime
} from '../../bmc/main/ipmi'

/**
 * The four readers that turn ipmitool's own text into the rows and facts the
 * management page draws. Every fixture here is the shape a real BMC prints,
 * because the only thing these functions are ever fed is firmware output that
 * nobody in this repo controls - an invented fixture proves the parser agrees
 * with the test author, not with the tool.
 */

describe('parsePowerStatus: the single line `ipmitool chassis power status` prints', () => {
  it('reads the running and stopped states the tool actually words', () => {
    expect(parsePowerStatus('Chassis Power is on\n')).toBe('on')
    expect(parsePowerStatus('Chassis Power is off\n')).toBe('off')
  })

  it('answers null for anything that is not a power status, so a failed call never reads as "off"', () => {
    // "off" is an actionable state - it makes the page offer a power-on button
    // and counts the machine as healthy-but-idle. Guessing it from a session
    // that never opened would be worse than admitting the state is unknown.
    expect(parsePowerStatus('Error: Unable to establish IPMI v2 / RMCP+ session\n')).toBeNull()
    expect(parsePowerStatus('')).toBeNull()
  })

  it('does not mistake what `chassis power off` echoes back for a status read', () => {
    // The control commands answer with the state they just asked for, not the
    // state the chassis reached; only `power status` reports the latter.
    expect(parsePowerStatus('Chassis Power Control: Down/Off\n')).toBeNull()
    expect(parsePowerStatus('Chassis Power Control: Up/On\n')).toBeNull()
  })

  it('accepts whatever case the firmware chose but always answers in lower case', () => {
    expect(parsePowerStatus('CHASSIS POWER IS ON')).toBe('on')
    expect(parsePowerStatus('chassis power is Off')).toBe('off')
  })

  it('finds the status line among the other lines a command printed', () => {
    expect(parsePowerStatus('Set Chassis Power State to on\nChassis Power is on\n')).toBe('on')
  })
})

/**
 * `ipmitool sel elist last 100` on a Supermicro X11: five entries, one of them
 * logged before the BMC's clock had been set. Record ids are printed in hex,
 * which is why `a` follows `3` and `10` follows `f`.
 */
const SEL_ELIST = [
  '   1 | 03/14/2026 | 09:12:44 | Temperature #0x01 | Upper Critical going high | Asserted',
  '   2 | Pre-Init  |0000005616| Power Unit #0x51 | Power off/down | Asserted',
  '   3 | 03/14/2026 | 09:13:02 | Temperature #0x01 | Upper Critical going high | Deasserted',
  '   a | 03/14/2026 | 10:04:19 | Fan #0x30 | Lower Critical going low | Asserted',
  '  10 | 03/15/2026 | 02:00:07 | Event Logging Disabled #0x72 | Log area reset/cleared | Asserted',
  ''
].join('\n')

describe('parseSel: the event log, as the BMC worded it', () => {
  it('parses the record id out of hex into a number, so the table sorts by age and not by spelling', () => {
    const rows = parseSel(SEL_ELIST)

    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 10, 16])
    // The management page sorts on `seq` descending. Sorting the ids as text
    // instead would read 10 < 2 < 3 < a and put the newest entry fourth.
    expect([...rows].sort((a, b) => a.seq - b.seq).map((row) => row.idx)).toEqual([
      '1',
      '2',
      '3',
      'a',
      '10'
    ])
  })

  it('joins the date and time columns into one "when" for an entry the clock timestamped', () => {
    expect(parseSel(SEL_ELIST)[0]).toEqual({
      idx: '1',
      seq: 1,
      when: '03/14/2026 09:12:44',
      sensor: 'Temperature #0x01',
      event: 'Upper Critical going high — Asserted'
    })
  })

  it('puts the sensor and event of a pre-init entry in the same fields as a timestamped one', () => {
    // ipmitool prints the pre-init marker and the raw counter as two columns,
    // so the sensor and its event sit where they always do - a reader that
    // shifted them would fill the Sensor column with a ten-digit number.
    const preInit = parseSel(SEL_ELIST)[1]

    expect(preInit.sensor).toBe('Power Unit #0x51')
    expect(preInit.event).toBe('Power off/down — Asserted')
    expect(preInit.seq).toBe(2)
  })

  it('invents no time of day for an entry the BMC logged before its clock was set', () => {
    // `Pre-Init |0000005616|` is seconds since the controller started, not a
    // reading of any clock. Carrying it into the "When (BMC clock)" column
    // dresses an uptime counter up as a timestamp.
    expect(parseSel(SEL_ELIST)[1].when).toBe('Pre-Init')
  })

  it('leaves "when" as text and adds no epoch beside it, because only the BMC knows its own zone', () => {
    const rows = parseSel(SEL_ELIST)

    // Converting `03/14/2026 09:12:44` to a number would have to assume a
    // timezone the BMC never reported - the app's, almost certainly wrong.
    expect(Object.keys(rows[0]).sort()).toEqual(['event', 'idx', 'sensor', 'seq', 'when'])
    expect(rows[3].when).toBe('03/14/2026 10:04:19')
    expect(typeof rows[3].when).toBe('string')
  })

  it('keeps a repeated record id unique in idx while leaving seq the number the firmware gave', () => {
    // `sel clear` restarts the ids at 1, so a log read across a clear can show
    // the same id twice; `idx` is the table's rowKey and two equal keys make
    // the renderer drop a row.
    const rows = parseSel(
      [
        '   1 | 03/14/2026 | 09:12:44 | Temperature #0x01 | Upper Critical going high | Asserted',
        '   1 | 03/15/2026 | 11:00:01 | Fan #0x30 | Lower Critical going low | Asserted',
        '   1 | 03/15/2026 | 11:04:38 | Fan #0x30 | Lower Critical going low | Deasserted'
      ].join('\n')
    )

    expect(rows.map((row) => row.idx)).toEqual(['1', '1-2', '1-3'])
    expect(rows.map((row) => row.seq)).toEqual([1, 1, 1])
  })

  it('skips lines that are not a five-column entry rather than emitting a half-read row', () => {
    const rows = parseSel(
      [
        '',
        '   4 | 03/14/2026 | 09:20:11 | Watchdog2 #0x71',
        '   5 | 03/14/2026 | 09:20:1',
        'SEL has no entries',
        '   6 | 03/14/2026 | 09:33:07 | Power Supply #0x02 | Failure detected | Asserted'
      ].join('\n')
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].idx).toBe('6')
  })
})

/** `ipmitool mc info` against a Supermicro BMC, continuation lines and all. */
const MC_INFO = [
  'Device ID                 : 32',
  'Device Revision           : 1',
  'Firmware Revision         : 3.88',
  'IPMI Version              : 2.0',
  'Manufacturer ID           : 10876',
  'Manufacturer Name         : Supermicro',
  'Product ID                : 2098 (0x0832)',
  'Product Name              : Unknown (0x832)',
  'Device Available          : yes',
  'Provides Device SDRs      : no',
  'Additional Device Support :',
  '    Sensor Device',
  '    SDR Repository Device',
  '    SEL Device',
  '    FRU Inventory Device',
  '    IPMB Event Receiver',
  '    Chassis Device',
  'Aux Firmware Rev Info     :',
  '    0x00',
  '    0x00',
  ''
].join('\n')

describe('parseMcInfo: the controller behind the address', () => {
  it('picks the three facts worth showing out of the twenty the tool prints', () => {
    expect(parseMcInfo(MC_INFO)).toEqual({
      firmware: '3.88',
      manufacturer: 'Supermicro',
      product: 'Unknown (0x832)'
    })
  })

  it('falls back to the numeric product id when the firmware ships no product name', () => {
    const withoutName = MC_INFO.split('\n')
      .filter((line) => !line.startsWith('Product Name'))
      .join('\n')

    expect(parseMcInfo(withoutName).product).toBe('2098 (0x0832)')
  })

  it('yields empty strings for keys that are absent, so a caller renders a blank and not "undefined"', () => {
    expect(parseMcInfo('')).toEqual({ firmware: '', manufacturer: '', product: '' })
    expect(parseMcInfo('Device ID                 : 32\n')).toEqual({
      firmware: '',
      manufacturer: '',
      product: ''
    })
  })
})

/**
 * What `runIpmiInspect` brings back: `mc info`, `fru print` and `lan print 1`
 * run in one shell command, each behind the `===NAME===` marker the collectors
 * use everywhere (shared/shell splitSections).
 */
const INSPECT = [
  '===MC===',
  'Device ID                 : 32',
  'Firmware Revision         : 3.88',
  'IPMI Version              : 2.0',
  'Manufacturer ID           : 10876',
  'Manufacturer Name         : Supermicro',
  'Product Name              : Unknown (0x832)',
  '===FRU===',
  'FRU Device Description : Builtin FRU Device (ID 0)',
  ' Chassis Type          : Rack Mount Chassis',
  ' Chassis Serial        : C8190AK27A20001',
  ' Board Mfg Date        : Mon Jan  1 00:00:00 1996',
  ' Board Mfg             : Super Micro Computer Inc',
  ' Board Product         : X11DPU',
  ' Board Serial          : WM188S002143',
  ' Board Part Number     : X11DPU',
  ' Product Manufacturer  : Supermicro',
  ' Product Name          : Super Server',
  ' Product Serial        : S249572X9820402',
  '===LAN===',
  'Set in Progress         : Set Complete',
  'IP Address Source       : Static Address',
  'IP Address              : 10.0.0.5',
  'Subnet Mask             : 255.255.255.0',
  'MAC Address             : 0c:c4:7a:6b:12:34',
  'Default Gateway IP      : 10.0.0.1',
  ''
].join('\n')

describe('parseInspect: folding one batched command back into machine facts', () => {
  it('takes the controller facts from MC, the board from FRU and the address from LAN', () => {
    expect(parseInspect(INSPECT)).toEqual({
      firmware: '3.88',
      ipmiVersion: '2.0',
      manufacturer: 'Supermicro',
      product: 'X11DPU',
      serial: 'WM188S002143',
      mac: '0c:c4:7a:6b:12:34'
    })
  })

  it('reads a MAC whose own value is full of colons', () => {
    // The key/value split has to stop at the first colon; splitting at the last
    // one leaves a MAC of "34" under a key nobody looks up.
    expect(parseInspect(INSPECT).mac).toBe('0c:c4:7a:6b:12:34')
  })

  it('does not mistake "Board Mfg Date" for "Board Mfg" when the date is what comes first', () => {
    const onlyBoardMfg = INSPECT.split('\n')
      .filter((line) => !/Manufacturer Name|Product Manufacturer/.test(line))
      .join('\n')

    expect(parseInspect(onlyBoardMfg).manufacturer).toBe('Super Micro Computer Inc')
  })

  it('prefers the controller\'s own maker over the board\'s when MC answered', () => {
    // The two disagree on real hardware - "Supermicro" from the BMC against
    // "Super Micro Computer Inc" stamped in the FRU - so the preference is
    // observable rather than a tie.
    expect(parseInspect(INSPECT).manufacturer).toBe('Supermicro')
  })

  it('falls back through the FRU maker keys in order when MC named nobody', () => {
    const fruOnly = (...lines: string[]): string => ['===FRU===', ...lines, ''].join('\n')

    expect(
      parseInspect(
        fruOnly(' Board Mfg             : Super Micro Computer Inc', ' Product Manufacturer  : Supermicro')
      ).manufacturer
    ).toBe('Supermicro')
    expect(parseInspect(fruOnly(' Board Mfg             : Super Micro Computer Inc')).manufacturer).toBe(
      'Super Micro Computer Inc'
    )
    // Some firmware spells the FRU field out in full instead of abbreviating.
    expect(parseInspect(fruOnly(' Board Manufacturer    : ASRockRack')).manufacturer).toBe('ASRockRack')
  })

  it('leaves the fields of a section the BMC could not answer empty instead of throwing', () => {
    // `runIpmiInspect` lets `fru print` and `lan print` fail with `|| true`,
    // because plenty of controllers implement neither - the markers are still
    // echoed, with nothing under them.
    expect(parseInspect(['===MC===', 'Firmware Revision : 3.88', '===FRU===', '===LAN===', ''].join('\n'))).toEqual(
      { firmware: '3.88', ipmiVersion: '', manufacturer: '', product: '', serial: '', mac: '' }
    )
  })

  it('returns every field empty for output with no sections at all', () => {
    expect(parseInspect('')).toEqual({
      firmware: '',
      ipmiVersion: '',
      manufacturer: '',
      product: '',
      serial: '',
      mac: ''
    })
  })

  it('ignores whatever the shell printed before the first marker', () => {
    // Anything the login shell says on the way in - a banner, a sudo notice -
    // arrives ahead of the first `echo '===MC==='` and belongs to no section.
    const withBanner = `Welcome to Ubuntu 24.04.1 LTS\nLast login: Sat Mar 14 09:00:11 2026\n${INSPECT}`

    expect(parseInspect(withBanner)).toEqual(parseInspect(INSPECT))
  })
})

/* ------------------------------------------------------------------------ */
/* parseSelTime                                                              */
/* ------------------------------------------------------------------------ */

describe('parseSelTime(): the clock that stamped the event log', () => {
    it('reads the controller clock as the reading machine own local time', () => {
        // The controller prints a local time with no zone on it, because it does
        // not know its own. Reading it as local is the only interpretation that
        // makes the ordinary case - both set from the same source, in the same
        // room - come out as no drift at all.
        const at = parseSelTime(' 08/30/2026 09:14:22\n')

        expect(at).toBe(new Date(2026, 7, 30, 9, 14, 22).getTime())
    })

    it('reads it out of the sentence ipmitool actually prints', () => {
        expect(parseSelTime('SEL Time is 12/01/2026 23:59:01')).toBe(
            new Date(2026, 11, 1, 23, 59, 1).getTime()
        )
    })

    it('answers null for a controller whose clock was never set', () => {
        // Not drift - "never set", which needs a different sentence: the times
        // in its log are a count from its last boot, not times of day.
        expect(parseSelTime('01/01/1970 00:00:04')).toBeNull()
        expect(parseSelTime('01/01/2000 00:00:00')).toBeNull()
    })

    it('answers null when there is no time in the answer at all', () => {
        expect(parseSelTime('')).toBeNull()
        expect(parseSelTime('Error: Unable to establish IPMI v2 / RMCP+ session')).toBeNull()
    })
})
