import { describe, expect, it } from 'vitest'
import type { ModuleContext, ModuleExecResult } from '@shared/modules'
import { moduleHarness, sharedModuleConfig } from '../helpers/module-harness'
import { Queries } from '../../bmc/main/queries'
import { ConfigStore, Credentials } from '../../bmc/main/store'

/**
 * The drawer reads - inspection facts, the sensor table, the event log - and
 * what they say when the BMC does not answer.
 *
 * Version 1 of this module returned a bare `[]` from every one of them, so
 * "this BMC has no event log entries" and "this BMC did not answer" drew the
 * same empty table. Version 2 answers with `{ rows, problem, t }`, and these
 * tests pin the four properties that make that worth having: the problem is a
 * sentence naming what ipmitool said, a failure is never cached, a read for a
 * machine that has been edited or deleted is refused rather than served from
 * the previous revision's cache - and a credential this install cannot use is
 * reported as itself, before anything is asked of the network.
 *
 * That last one is why `Queries` takes a `Credentials`: passwords live in the
 * app's encrypted store from 0.6.0 onwards, and each read fetches one for
 * exactly the call it is about to make.
 */

const M1_HOST = "-H '10.0.0.5'"
const M2_HOST = "-H '10.0.0.6'"

/** `ipmitool sdr elist` against a chassis with one warned fan and one failed PSU. */
const SDR_STDOUT = `CPU1 Temp        | 01h | ok  |  3.1 | 45 degrees C
CPU2 Temp        | 02h | ns  |  3.2 | Disabled
FAN1             | 41h | ok  | 29.1 | 3500 RPM
FAN2             | 42h | nc  | 29.2 | 700 RPM
12V              | 30h | ok  |  7.1 | 12.031 Volts
PS1 Status       | 70h | cr  | 10.1 | Failure detected
`

/** `ipmitool sensor list` - the thresholds behind each reading, `na` where there are none. */
const SENSOR_LIST_STDOUT = `CPU1 Temp        | 45.000     | degrees C  | ok    | na        | na        | na        | 85.000    | 90.000    | 95.000
FAN1             | 3500.000   | RPM        | ok    | na        | 500.000   | 700.000   | na        | na        | na
FAN2             | 700.000    | RPM        | nc    | na        | 500.000   | 700.000   | na        | na        | na
12V              | 12.031     | Volts      | ok    | na        | na        | na        | na        | na        | na
PS1 Status       | 0x0        | discrete   | cr    | na        | na        | na        | na        | na        | na
`

/** `ipmitool sel elist last <n>` - the newest entries, oldest of them first. */
const SEL_STDOUT = `   1 | 04/12/2026 | 09:12:44 | Temperature CPU1 Temp | Upper Critical going high | Asserted | Reading 96 > Threshold 90 degrees C
   2 | 04/12/2026 | 09:13:02 | Power Supply PS1 Status | Failure detected | Asserted
   3 | 04/12/2026 | 11:41:07 | Power Unit Pwr Unit Status | Power off/down | Asserted
`

/** What the same log answers when a larger count reaches further back into it. */
const SEL_DEEP_STDOUT = `   a | 04/11/2026 | 22:03:15 | Physical Security Chassis Intru | General Chassis intrusion | Asserted
   b | 04/12/2026 | 02:47:51 | Fan FAN2 | Lower Non-critical going low | Asserted
${SEL_STDOUT}`

/** The batched `mc info` / `fru print` / `lan print 1` inspection, with its section markers. */
const INSPECT_STDOUT = `===MC===
Device ID                 : 32
Device Revision           : 1
Firmware Revision         : 3.88
IPMI Version              : 2.0
Manufacturer ID           : 10876
Manufacturer Name         : Supermicro
Product ID                : 2402 (0x0962)
===FRU===
FRU Device Description : Builtin FRU Device (ID 0)
 Board Mfg             : Supermicro
 Board Product         : X11DPi-N
 Board Serial          : WM214S000123
===LAN===
Set in Progress         : Set Complete
IP Address Source       : Static Address
IP Address              : 10.0.0.5
MAC Address             : 0c:c4:7a:11:22:33
`

/** No route to the management port: nothing ever answers the RMCP+ handshake. */
const UNREACHABLE: ModuleExecResult = {
  stdout: '',
  stderr: 'Error: Unable to establish IPMI v2 / RMCP+ session\n',
  code: 1
}

/** The saved password no longer matches the account on the BMC. */
const AUTH_FAILED: ModuleExecResult = {
  stdout: '',
  stderr: 'Error: RAKP 2 HMAC is invalid\nError: Unable to establish IPMI v2 / RMCP+ session\n',
  code: 1
}

type ReadKind = 'sdr' | 'sensorList' | 'sel' | 'inspect'

function ok(stdout: string): ModuleExecResult {
  return { stdout, stderr: '', code: 0 }
}

function kindOf(command: string): ReadKind {
  if (command.includes('sdr elist')) return 'sdr'
  if (command.includes('sensor list')) return 'sensorList'
  if (command.includes('sel elist')) return 'sel'
  if (command.includes('===MC===')) return 'inspect'
  throw new Error(`no fixture for command: ${command}`)
}

/** The `<n>` an event log read asked for, which is the only settings-derived argument any of these commands carry. */
function selCountOf(command: string): number {
  const match = command.match(/sel elist last (\d+)/)
  if (!match) throw new Error(`no fetch count in command: ${command}`)
  return Number(match[1])
}

/**
 * A version 3 settings document with two enabled machines - version 3 being
 * the one with no passwords in it. Both machines' credentials are in the
 * harness's secret store instead, under the keys `Credentials` uses.
 */
function bmcDocument(selFetchCount = 100): unknown {
  return {
    version: 3,
    hintsOn: true,
    settings: { sweepConcurrency: 4, sensorEverySweeps: 3, selFetchCount, identifySeconds: 15 },
    machines: [
      {
        id: 'm1',
        revision: 'r1',
        name: 'rack-a-01',
        ip: '10.0.0.5',
        port: 623,
        username: 'admin',
        enabled: true
      },
      {
        id: 'm2',
        revision: 'r2',
        name: 'rack-a-02',
        ip: '10.0.0.6',
        port: 623,
        username: 'admin',
        enabled: true
      }
    ]
  }
}

/** Both machines' passwords, saved and readable - the ordinary case. */
const SAVED_PASSWORDS: Record<string, string> = {
  'machine/m1': 'secret',
  'machine/m2': 'secret'
}

interface Rig {
  queries: Queries
  /** The module's context, for a test that needs to store a credential mid-run. */
  ctx: ModuleContext
  /** Reassign a member to make that read fail from the next call onwards. */
  replies: Record<ReadKind, ModuleExecResult>
  /**
   * An event log per fetch count, so an assertion can be about which command
   * produced the rows rather than only about how many runs there were. A count
   * with no entry here falls back to `replies.sel`.
   */
  selByCount: Map<number, ModuleExecResult>
  /** Every command `exec` was given that contains all of `fragments`. */
  calls(...fragments: string[]): string[]
  /** Hold every exec open - so two calls really do overlap - until the returned function is called. */
  blockExec(): () => void
  /** What another connected machine's instance of this module writing the document looks like from here. */
  writeConfig(document: unknown): void
}

interface RigOptions {
  selFetchCount?: number
  /** Secret store contents, by key; defaults to both machines' passwords. */
  secrets?: Record<string, string>
  /** Keys stored under a secret key this install no longer has. */
  unreadableSecrets?: string[]
}

function rig(options: RigOptions = {}): Rig {
  const replies: Record<ReadKind, ModuleExecResult> = {
    sdr: ok(SDR_STDOUT),
    sensorList: ok(SENSOR_LIST_STDOUT),
    sel: ok(SEL_STDOUT),
    inspect: ok(INSPECT_STDOUT)
  }
  const selByCount = new Map<number, ModuleExecResult>()
  let gate: Promise<void> | null = null
  const config = sharedModuleConfig(bmcDocument(options.selFetchCount))
  const harness = moduleHarness(
    'bmc',
    async (command: string) => {
      if (gate) await gate
      const kind = kindOf(command)
      if (kind === 'sel') {
        const forCount = selByCount.get(selCountOf(command))
        if (forCount) return forCount
      }
      return replies[kind]
    },
    {
      config,
      secrets: options.secrets ?? SAVED_PASSWORDS,
      unreadableSecrets: options.unreadableSecrets
    }
  )

  return {
    queries: new Queries(harness.ctx, new ConfigStore(harness.ctx), new Credentials(harness.ctx)),
    ctx: harness.ctx,
    replies,
    selByCount,
    calls: (...fragments: string[]) =>
      harness.exec.mock.calls
        .map((call) => call[0])
        .filter((command) => fragments.every((fragment) => command.includes(fragment))),
    blockExec: () => {
      let release = (): void => {}
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null
          resolve()
        }
      })
      return release
    },
    writeConfig: (document: unknown) => config.set(document)
  }
}

describe('sensorRows', () => {
  it('reports no problem as null rather than an empty string, so a healthy machine renders no problem panel', async () => {
    // The spec's conditional block tests `value != null`; '' is a value, and
    // would open an empty panel on every machine that is working perfectly.
    const result = await rig().queries.sensorRows('m1', 'r1')

    expect(result.problem).toBeNull()
    expect(result.t).toBeGreaterThan(0)
  })

  it('parses the sdr table and gives every row the coloured chip its status means', async () => {
    const result = await rig().queries.sensorRows('m1', 'r1')

    expect(result.rows).toHaveLength(6)
    expect(result.rows[0]).toMatchObject({
      name: 'CPU1 Temp',
      reading: '45 degrees C',
      value: 45,
      unit: '°C',
      status: 'ok'
    })

    const chipFor = (name: string): unknown => result.rows.find((row) => row.name === name)?.statusBadges
    expect(chipFor('CPU1 Temp')).toEqual([{ label: 'ok', color: '#22c55e' }])
    expect(chipFor('FAN2')).toEqual([{ label: 'warn', color: '#f59e0b' }])
    expect(chipFor('PS1 Status')).toEqual([{ label: 'bad', color: '#ef4444' }])
    // A sensor in "no state" is reported, not coloured: an unreadable row is
    // neither healthy nor a fault.
    expect(chipFor('CPU2 Temp')).toEqual([{ label: 'unknown' }])
    expect(result.rows.every((row) => row.statusBadges.length === 1)).toBe(true)
  })

  it('answers a failed sdr read with an empty table and a sentence carrying ipmitool own words', async () => {
    const r = rig()
    r.replies.sdr = UNREACHABLE

    const result = await r.queries.sensorRows('m1', 'r1')

    expect(result.rows).toEqual([])
    expect(result.problem).toContain('no route to the BMC')
    expect(result.problem).toContain('Unable to establish IPMI v2 / RMCP+ session')
  })

  it('does not cache a failed read, so the next poll retries instead of repeating the error for the whole TTL', async () => {
    const r = rig()
    r.replies.sdr = UNREACHABLE

    await r.queries.sensorRows('m1', 'r1')
    await r.queries.sensorRows('m1', 'r1')
    expect(r.calls('sdr elist')).toHaveLength(2)

    r.replies.sdr = ok(SDR_STDOUT)
    const recovered = await r.queries.sensorRows('m1', 'r1')
    expect(recovered.problem).toBeNull()
    expect(recovered.rows).toHaveLength(6)
  })

  it('caches a good read, so a second call inside the TTL costs no ipmitool run at all', async () => {
    const r = rig()

    const first = await r.queries.sensorRows('m1', 'r1')
    const second = await r.queries.sensorRows('m1', 'r1')

    expect(r.calls('sdr elist')).toHaveLength(1)
    expect(second).toBe(first)
  })

  it('de-duplicates two concurrent reads of the same machine into one round trip', async () => {
    const r = rig()
    const release = r.blockExec()

    const first = r.queries.sensorRows('m1', 'r1')
    const second = r.queries.sensorRows('m1', 'r1')
    release()
    const [a, b] = await Promise.all([first, second])

    expect(r.calls('sdr elist')).toHaveLength(1)
    expect(a).toBe(b)
  })
})

describe('selRows', () => {
  it('asks for the number of newest entries the settings document names, not a hardcoded 100', async () => {
    const r = rig({ selFetchCount: 25 })

    await r.queries.selRows('m1', 'r1')

    expect(r.calls('sel elist')[0]).toContain('sel elist last 25')
    expect(r.calls('sel elist')[0]).not.toContain('last 100')
  })

  it('reads the fetch count at call time, so changing the setting changes the next read', async () => {
    const r = rig({ selFetchCount: 25 })
    await r.queries.selRows('m1', 'r1')

    r.writeConfig(bmcDocument(250))
    // A machine that has not been read yet, so this is a fresh read rather
    // than the cached answer for m1.
    await r.queries.selRows('m2', 'r2')

    expect(r.calls('sel elist', M2_HOST)[0]).toContain('sel elist last 250')
  })

  it('parses the event log and reports no problem as null', async () => {
    const result = await rig().queries.selRows('m1', 'r1')

    expect(result.problem).toBeNull()
    expect(result.rows).toHaveLength(3)
    expect(result.rows[0]).toMatchObject({
      idx: '1',
      seq: 1,
      when: '04/12/2026 09:12:44',
      sensor: 'Temperature CPU1 Temp'
    })
    expect(result.rows[0].event).toContain('Upper Critical going high')
  })

  it('distinguishes "the log could not be read" from "the log is empty", and does not cache the failure', async () => {
    const r = rig()
    r.replies.sel = AUTH_FAILED

    const result = await r.queries.selRows('m1', 'r1')

    expect(result.rows).toEqual([])
    expect(result.problem).toContain('refused the saved credentials')
    expect(result.problem).toContain('RAKP 2 HMAC is invalid')

    await r.queries.selRows('m1', 'r1')
    expect(r.calls('sel elist')).toHaveLength(2)
  })
})

/**
 * The event log is the one read whose command depends on a setting, so its
 * cache key carries the count as well as the machine. Keyed on identity alone,
 * a user who opened the drawer, raised "Event log entries fetched" from 100 to
 * 1000, and came back inside the 30 s TTL was served the hundred rows the old
 * setting fetched, with nothing on screen to say the new one had not taken.
 */
describe('the SEL fetch count in the cache key', () => {
  it('asks for the default hundred newest entries, and for five hundred once the setting is raised', async () => {
    const r = rig()

    await r.queries.selRows('m1', 'r1')
    expect(r.calls('sel elist', M1_HOST)[0]).toContain('sel elist last 100')

    r.writeConfig(bmcDocument(500))
    await r.queries.selRows('m1', 'r1')

    expect(r.calls('sel elist', M1_HOST)[1]).toContain('sel elist last 500')
  })

  it('re-reads when the count changes inside the TTL, and answers with the rows the new command produced', async () => {
    const r = rig()
    r.selByCount.set(100, ok(SEL_STDOUT))
    r.selByCount.set(500, ok(SEL_DEEP_STDOUT))

    const hundred = await r.queries.selRows('m1', 'r1')
    expect(hundred.rows).toHaveLength(3)
    expect(hundred.rows[0].sensor).toBe('Temperature CPU1 Temp')

    r.writeConfig(bmcDocument(500))
    const fiveHundred = await r.queries.selRows('m1', 'r1')

    expect(r.calls('sel elist', M1_HOST)).toHaveLength(2)
    expect(fiveHundred.rows).toHaveLength(5)
    expect(fiveHundred.rows[0].sensor).toBe('Physical Security Chassis Intru')
    expect(fiveHundred.rows.map((row) => row.idx)).toEqual(['a', 'b', '1', '2', '3'])
  })

  it('replays the first answer when the count goes back inside the TTL, which is why the count is keyed rather than cleared', async () => {
    const r = rig()
    r.selByCount.set(100, ok(SEL_STDOUT))
    r.selByCount.set(500, ok(SEL_DEEP_STDOUT))

    const hundred = await r.queries.selRows('m1', 'r1')
    r.writeConfig(bmcDocument(500))
    await r.queries.selRows('m1', 'r1')

    r.writeConfig(bmcDocument(100))
    const again = await r.queries.selRows('m1', 'r1')

    // The entry the first read left is still valid: nothing about that machine
    // or that count changed while the user was looking at the other one.
    expect(r.calls('sel elist', M1_HOST)).toHaveLength(2)
    expect(again).toBe(hundred)
  })

  it('leaves the sensor table and the inspection cached across a count change, because neither command carries the setting', async () => {
    const r = rig()
    const sensors = await r.queries.sensorRows('m1', 'r1')
    const inspect = await r.queries.machineInspect('m1', 'r1')

    r.writeConfig(bmcDocument(500))

    expect(await r.queries.sensorRows('m1', 'r1')).toBe(sensors)
    expect(await r.queries.machineInspect('m1', 'r1')).toBe(inspect)
    expect(r.calls('sdr elist', M1_HOST)).toHaveLength(1)
    expect(r.calls('===MC===', M1_HOST)).toHaveLength(1)
  })

  it('clearSel drops every count held for that machine, not only the one in force when the log was cleared', async () => {
    const r = rig()
    await r.queries.selRows('m1', 'r1')
    r.writeConfig(bmcDocument(500))
    await r.queries.selRows('m1', 'r1')
    await r.queries.selRows('m2', 'r2')
    expect(r.calls('sel elist')).toHaveLength(3)

    r.queries.clearSel('m1')

    // The count the entry was first read at is the one a naive keying change
    // would leave behind, still answering with entries the clear removed.
    r.writeConfig(bmcDocument(100))
    await r.queries.selRows('m1', 'r1')
    expect(r.calls('sel elist', M1_HOST)).toHaveLength(3)

    r.writeConfig(bmcDocument(500))
    await r.queries.selRows('m1', 'r1')
    expect(r.calls('sel elist', M1_HOST)).toHaveLength(4)

    // Another machine's log was not touched by clearing this one's.
    await r.queries.selRows('m2', 'r2')
    expect(r.calls('sel elist', M2_HOST)).toHaveLength(1)
  })
})

describe('machineInspect', () => {
  it('folds the mc/fru/lan sections into facts and reports no problem as null', async () => {
    const result = await rig().queries.machineInspect('m1', 'r1')

    expect(result).toEqual({
      name: 'rack-a-01',
      ip: '10.0.0.5',
      firmware: '3.88',
      ipmiVersion: '2.0',
      manufacturer: 'Supermicro',
      product: 'X11DPi-N',
      serial: 'WM214S000123',
      mac: '0c:c4:7a:11:22:33',
      problem: null
    })
  })

  it('still names the machine when the inspection fails, so the drawer header is not blank', async () => {
    const r = rig()
    r.replies.inspect = AUTH_FAILED

    const result = await r.queries.machineInspect('m1', 'r1')

    expect(result.name).toBe('rack-a-01')
    expect(result.ip).toBe('10.0.0.5')
    expect(result.firmware).toBe('')
    expect(result.problem).toContain('refused the saved credentials')
    expect(result.problem).toContain('RAKP 2 HMAC is invalid')

    // The inspect cache holds for ten minutes; caching this would keep a stale
    // failure on screen long after the password was fixed.
    await r.queries.machineInspect('m1', 'r1')
    expect(r.calls('===MC===')).toHaveLength(2)
  })

  it('says the entry is gone for an id that is not in the document, rather than an empty success', async () => {
    const r = rig()

    const result = await r.queries.machineInspect('deleted-machine', 'r1')

    expect(result.problem).toContain('gone or was changed')
    expect(result.name).toBe('')
    expect(r.calls('ipmitool')).toHaveLength(0)
  })
})

/**
 * The credential is fetched per call and never kept, so every one of these
 * reads has to cope with not getting one. Two things make that worth pinning.
 *
 * The first is that "no password was ever saved" and "the saved password can no
 * longer be decrypted" are different problems with different fixes, and only
 * the second means somebody has to go and find the password again. Collapsing
 * them into one message would send a user hunting for a credential they never
 * entered, or leave them re-saving one that is already there.
 *
 * The second is that neither may reach the network. `ipmitool` with an empty
 * password is a failed authentication attempt, and BMCs lock accounts for
 * enough of those - so a drawer opened on a machine whose credential is gone
 * must not be the thing that locks its account out.
 */
describe('a credential that cannot be used', () => {
  const MISSING = /no password is saved for this bmc/i
  const UNREADABLE = /cannot be read.*secret key is not the one it was written with/is

  it('answers all three reads with "no password is saved", and asks the BMC nothing', async () => {
    const r = rig({ secrets: {} })

    const inspect = await r.queries.machineInspect('m1', 'r1')
    const sensors = await r.queries.sensorRows('m1', 'r1')
    const sel = await r.queries.selRows('m1', 'r1')

    expect(inspect.problem).toMatch(MISSING)
    expect(sensors.problem).toMatch(MISSING)
    expect(sel.problem).toMatch(MISSING)
    expect(sensors.rows).toEqual([])
    expect(sel.rows).toEqual([])
    // Not one ipmitool run: an empty password is a failed authentication, and
    // three of them per drawer poll is how an account gets locked.
    expect(r.calls()).toEqual([])
  })

  it('says to enter it again when the stored password can no longer be decrypted', async () => {
    const r = rig({ unreadableSecrets: ['machine/m1'] })

    const inspect = await r.queries.machineInspect('m1', 'r1')
    const sensors = await r.queries.sensorRows('m1', 'r1')
    const sel = await r.queries.selRows('m1', 'r1')

    // A different sentence from the one above, because it is a different job:
    // the password exists, this install just cannot open it any more.
    expect(inspect.problem).toMatch(UNREADABLE)
    expect(sensors.problem).toMatch(UNREADABLE)
    expect(sel.problem).toMatch(UNREADABLE)
    expect(r.calls()).toEqual([])
  })

  it('still names the machine, so the drawer header is not blank while the password is missing', async () => {
    const r = rig({ secrets: {} })

    const inspect = await r.queries.machineInspect('m1', 'r1')

    // The same courtesy a failed inspection gets: the row the user clicked is
    // still identified, and only the facts it could not read are empty.
    expect(inspect.name).toBe('rack-a-01')
    expect(inspect.ip).toBe('10.0.0.5')
    expect(inspect.firmware).toBe('')
  })

  it('leaves the other machine alone - a credential problem is per machine, not per fleet', async () => {
    const r = rig({ unreadableSecrets: ['machine/m1'] })

    expect((await r.queries.sensorRows('m1', 'r1')).problem).toMatch(UNREADABLE)
    const healthy = await r.queries.sensorRows('m2', 'r2')

    expect(healthy.problem).toBeNull()
    expect(healthy.rows).toHaveLength(6)
    expect(r.calls('sdr elist', M2_HOST)).toHaveLength(1)
  })

  it('does not cache the refusal, so the read works the moment the password is entered', async () => {
    const r = rig({ secrets: {} })
    expect((await r.queries.sensorRows('m1', 'r1')).problem).toMatch(MISSING)

    await r.ctx.secretSet('machine/m1', 'secret')
    const recovered = await r.queries.sensorRows('m1', 'r1')

    // Caching this would keep "no password is saved" on screen for the whole
    // TTL after the user had just saved one, which reads as the save failing.
    expect(recovered.problem).toBeNull()
    expect(recovered.rows).toHaveLength(6)
  })
})

describe('the revision guard', () => {
  it('refuses a read whose revision no longer matches instead of answering for a different revision', async () => {
    const r = rig()
    const fresh = await r.queries.sensorRows('m1', 'r1')
    expect(fresh.rows).toHaveLength(6)

    const stale = await r.queries.sensorRows('m1', 'r-edited-elsewhere')

    expect(stale.rows).toEqual([])
    expect(stale.problem).toContain('gone or was changed')
    // Nothing was asked of the BMC, and the previous revision's rows were not
    // handed out under the new one.
    expect(r.calls('sdr elist')).toHaveLength(1)
  })

  it('does not serve a cached reading for an entry that has since been edited', async () => {
    const r = rig()
    await r.queries.sensorRows('m1', 'r1')

    // The same id, moved to a different address by an edit made anywhere.
    const edited = bmcDocument() as { machines: Array<{ id: string; revision: string; ip: string }> }
    edited.machines[0].revision = 'r1-moved'
    edited.machines[0].ip = '10.0.0.9'
    r.writeConfig(edited)
    await r.queries.sensorRows('m1', 'r1-moved')

    expect(r.calls('sdr elist', "-H '10.0.0.9'")).toHaveLength(1)
  })

  it('answers selRows for a stale revision with the same refusal, not an empty event log', async () => {
    const result = await rig().queries.selRows('m1', 'r-old')

    expect(result.rows).toEqual([])
    expect(result.problem).toContain('gone or was changed')
  })
})

describe('cache invalidation', () => {
  async function warm(r: Rig): Promise<void> {
    await r.queries.machineInspect('m1', 'r1')
    await r.queries.sensorRows('m1', 'r1')
    await r.queries.selRows('m1', 'r1')
    await r.queries.machineInspect('m2', 'r2')
    await r.queries.sensorRows('m2', 'r2')
    await r.queries.selRows('m2', 'r2')
  }

  async function readAll(r: Rig): Promise<void> {
    await r.queries.machineInspect('m1', 'r1')
    await r.queries.sensorRows('m1', 'r1')
    await r.queries.selRows('m1', 'r1')
    await r.queries.machineInspect('m2', 'r2')
    await r.queries.sensorRows('m2', 'r2')
    await r.queries.selRows('m2', 'r2')
  }

  it('clearMachine drops all three reads for that machine and leaves every other machine cached', async () => {
    const r = rig()
    await warm(r)
    expect(r.calls('ipmitool')).toHaveLength(8)

    r.queries.clearMachine('m1')
    await readAll(r)

    expect(r.calls('===MC===', M1_HOST)).toHaveLength(2)
    expect(r.calls('sdr elist', M1_HOST)).toHaveLength(2)
    expect(r.calls('sel elist', M1_HOST)).toHaveLength(2)
    expect(r.calls(M2_HOST)).toHaveLength(4)
  })

  it('clearSel drops only the event log, because clearing an SEL is all that changed', async () => {
    const r = rig()
    await warm(r)

    r.queries.clearSel('m1')
    await readAll(r)

    expect(r.calls('sel elist', M1_HOST)).toHaveLength(2)
    expect(r.calls('===MC===', M1_HOST)).toHaveLength(1)
    expect(r.calls('sdr elist', M1_HOST)).toHaveLength(1)
    expect(r.calls(M2_HOST)).toHaveLength(4)
  })

  it('reset clears every read for every machine', async () => {
    const r = rig()
    await warm(r)

    r.queries.reset()
    await readAll(r)

    expect(r.calls('ipmitool')).toHaveLength(16)
  })
})

/* ------------------------------------------------------------------------ */
/* Thresholds                                                                */
/* ------------------------------------------------------------------------ */

describe('the thresholds behind a reading', () => {
    it('asks for them alongside the readings, and says how much room is left', async () => {
        // `sdr elist` says whether a reading is inside its thresholds;
        // `sensor list` says what they are. Together they turn "ok" into
        // "ok, and eight degrees from not being".
        const r = rig()

        const result = await r.queries.sensorRows('m1', 'r1')

        expect(r.calls('sensor list', M1_HOST)).toHaveLength(1)
        const withLimits = result.rows.filter((row) => row.headroom != null)
        expect(withLimits.length).toBeGreaterThan(0)
        for (const row of withLimits) expect(row.limit).not.toBeNull()
    })

    it('leaves a row alone when its controller has no threshold configured', async () => {
        // Most rows on most boards. Inventing a limit for one would be worse
        // than the column being empty.
        const r = rig()

        const result = await r.queries.sensorRows('m1', 'r1')

        const unlimited = result.rows.filter((row) => row.limit == null)
        expect(unlimited.length).toBeGreaterThan(0)
        for (const row of unlimited) expect(row.headroom).toBeNull()
    })

    it('still answers the readings when the threshold read fails', async () => {
        // The thresholds are the extra, not the point. A controller that
        // refuses `sensor list` must not cost the user their sensor table.
        const r = rig()
        r.replies.sensorList = { stdout: '', stderr: 'Error: Unsupported command', code: 1 }

        const result = await r.queries.sensorRows('m1', 'r1')

        expect(result.problem).toBeNull()
        expect(result.rows.length).toBeGreaterThan(0)
        for (const row of result.rows) expect(row.limit).toBeNull()
    })

})
