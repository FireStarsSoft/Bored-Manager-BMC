import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import activateBmc from '../../bmc/main/index'
import {
  buildMachinesPayload,
  describeState,
  foldSensors,
  worst,
  STATUS_WEIGHT,
  type MachineRuntimeState,
  type MachinesPayload,
  type SensorHealth
} from '../../bmc/main/sweep'
import { failureLabel, IPMI_FAILURES, type ItemStatus } from '../../bmc/main/ipmi'
import type { MachineRow } from '../../bmc/main/machines'
import {
  DEFAULT_SETTINGS,
  normalize,
  type BmcConfig,
  type BmcMachine,
  type BmcSettings
} from '../../bmc/main/store'

/**
 * The rule the whole file is about: a card is green only when nothing the
 * module knows about that machine is wrong. Power alone is not enough - a
 * chassis with a stopped fan is still "on" - and neither is a sensor read the
 * module could not confirm.
 */

const ALL_STATUSES: readonly ItemStatus[] = ['bad', 'warn', 'unknown', 'ok']

function sensorsWith(partial: Partial<SensorHealth> = {}): SensorHealth {
  return { at: Date.UTC(2026, 7, 30, 9, 0, 0), bad: 0, warn: 0, unknown: 0, total: 12, worst: [], ...partial }
}

function stateWith(partial: Partial<MachineRuntimeState> = {}): MachineRuntimeState {
  return { revision: 'r1', power: 'on', reach: 'ok', lastSeen: null, sensors: null, draw: null,
    clock: null, ...partial }
}

/**
 * A settings document as it sits on disk, read back through the real reader.
 *
 * Version 3: no passwords in it at all. They live in the app's encrypted
 * secret store now, keyed `machine/<id>`, and `bmcHarness` below seeds that
 * store rather than this document.
 */
function doc(machines: ReadonlyArray<Partial<BmcMachine>>, settings: Partial<BmcSettings> = {}): unknown {
  return {
    version: 3,
    hintsOn: true,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    machines: machines.map((entry, index) => ({
      id: `m${index + 1}`,
      revision: `r${index + 1}`,
      name: `Server ${index + 1}`,
      ip: `10.0.0.${index + 5}`,
      port: 623,
      username: 'admin',
      enabled: true,
      ...entry
    }))
  }
}

function configOf(
  machines: ReadonlyArray<Partial<BmcMachine>>,
  settings: Partial<BmcSettings> = {}
): BmcConfig {
  return normalize(doc(machines, settings))
}

describe('worst() and STATUS_WEIGHT: which of two findings a card is painted with', () => {
  it('orders the four statuses bad < warn < unknown < ok, so the most alarming one always wins', () => {
    expect(STATUS_WEIGHT.bad).toBeLessThan(STATUS_WEIGHT.warn)
    expect(STATUS_WEIGHT.warn).toBeLessThan(STATUS_WEIGHT.unknown)
    expect(STATUS_WEIGHT.unknown).toBeLessThan(STATUS_WEIGHT.ok)
  })

  it('places not knowing between a clean bill and a fault, because a gap is not a failure', () => {
    expect(worst('ok', 'unknown')).toBe('unknown')
    expect(worst('warn', 'unknown')).toBe('warn')
    expect(worst('bad', 'unknown')).toBe('bad')
  })

  it('gives the same answer whichever way round the pair is passed', () => {
    // Callers fold in whatever order they happen to have the two findings, so
    // an asymmetric fold would paint the same machine differently depending on
    // which check ran first.
    for (const a of ALL_STATUSES) {
      for (const b of ALL_STATUSES) {
        expect(worst(a, b)).toBe(worst(b, a))
      }
    }
  })
})

describe('foldSensors(): the severity a sensor read contributes to its machine', () => {
  it('folds a read whose every row was unreadable to ok, so it cannot grey a card on its own', () => {
    // There is no null case to test: describeState decides what a machine with
    // no read at all contributes (nothing), and only ever folds a read that
    // exists. A read that happened but produced nothing legible is the case
    // this function has to get right, and the answer is "says nothing" rather
    // than "says something is wrong".
    expect(foldSensors(sensorsWith({ bad: 0, warn: 0, unknown: 3, total: 3 }))).toBe('ok')
  })

  it('lets one critical row carry the whole read, ahead of any number of warnings', () => {
    expect(foldSensors(sensorsWith({ bad: 1, warn: 4 }))).toBe('bad')
  })

  it('folds to warn when something is outside a non-critical threshold and nothing is critical', () => {
    expect(foldSensors(sensorsWith({ warn: 1, bad: 0 }))).toBe('warn')
  })

  it('folds to ok when every counted row was inside its thresholds', () => {
    expect(foldSensors(sensorsWith({ bad: 0, warn: 0, unknown: 0, total: 34 }))).toBe('ok')
  })

  it('folds to ok when the only rows it could not read were unparseable ones', () => {
    // Deliberate: an SDR entry this module cannot read is a gap in what it
    // knows, and greying an otherwise healthy card over one `ns` row would
    // teach people that the colour means nothing.
    expect(foldSensors(sensorsWith({ bad: 0, warn: 0, unknown: 6, total: 6 }))).toBe('ok')
  })
})

describe('describeState(): what one machine’s reading means', () => {
  it('says a parked machine is parked rather than pretending it was checked', () => {
    const presentation = describeState(stateWith({ sensors: sensorsWith({ bad: 3 }) }), false)

    expect(presentation.status).toBe('unknown')
    expect(presentation.powerLabel).toBe('Sweeping disabled')
    expect(presentation.summary).toBe('Parked - not being swept')
  })

  it('distinguishes "not checked yet" from anything the module actually found', () => {
    expect(describeState(undefined)).toEqual({
      status: 'unknown',
      powerLabel: 'Not checked yet',
      summary: 'Waiting for the first sweep'
    })
    expect(describeState(stateWith({ reach: null })).powerLabel).toBe('Not checked yet')
  })

  it('treats refused credentials as a warning, because the BMC plainly answered', () => {
    const presentation = describeState(stateWith({ reach: 'auth', power: null }))

    expect(presentation.status).toBe('warn')
    expect(presentation.powerLabel).toBe(failureLabel('auth'))
  })

  it('treats every other transport failure as a fault, named in that failure’s own words', () => {
    for (const failure of IPMI_FAILURES.filter((entry) => entry !== 'auth')) {
      const presentation = describeState(stateWith({ reach: failure, power: null }))

      expect(presentation.status).toBe('bad')
      expect(presentation.powerLabel).toBe(failureLabel(failure))
      expect(presentation.summary).toBe(failureLabel(failure))
    }
  })

  it('paints a reachable, powered-on machine green', () => {
    expect(describeState(stateWith({ power: 'on' }))).toEqual({
      status: 'ok',
      powerLabel: 'Power on',
      summary: 'Power on'
    })
  })

  it('paints a reachable, powered-off machine as unknown rather than as a fault', () => {
    const presentation = describeState(stateWith({ power: 'off' }))

    expect(presentation.status).toBe('unknown')
    expect(presentation.powerLabel).toBe('Power off')
  })

  it('calls a BMC that answered without a power state a fault, not an unreachable machine', () => {
    // v1 reported this as unreachable, which sent people to check cabling for
    // what is a firmware quirk on a controller that replied.
    const presentation = describeState(stateWith({ power: null, reach: 'ok' }))

    expect(presentation.status).toBe('bad')
    expect(presentation.powerLabel).toBe('No power state')
  })

  it('turns a powered-on machine red when one of its sensors is critical, and names it', () => {
    const presentation = describeState(
      stateWith({ power: 'on', sensors: sensorsWith({ bad: 1, total: 22 }) })
    )

    expect(presentation.status).toBe('bad')
    expect(presentation.powerLabel).toBe('Power on')
    expect(presentation.summary).toBe('Power on · 1 sensor critical')
  })

  it('counts warnings separately and pluralises them, so the subtitle reads as a sentence', () => {
    const presentation = describeState(
      stateWith({ power: 'on', sensors: sensorsWith({ bad: 2, warn: 1 }) })
    )

    expect(presentation.status).toBe('bad')
    expect(presentation.summary).toBe('Power on · 2 sensors critical, 1 sensor warning')
  })

  it('leaves a machine whose sensors have never been read on its power state alone', () => {
    expect(describeState(stateWith({ power: 'on', sensors: null })).status).toBe('ok')
  })

  it('drops a clean machine to unknown when the last sensor read failed, rather than certifying it green', () => {
    // The counts are the previous read's. They are no longer evidence of
    // health, so the card stops claiming it - and says why.
    const presentation = describeState(
      stateWith({
        power: 'on',
        sensors: sensorsWith({ bad: 0, warn: 0, total: 18, problem: 'The sensors could not be read.' })
      })
    )

    expect(presentation.status).toBe('unknown')
    expect(presentation.summary).toBe('Power on · sensors unread')
  })

  it('keeps a known fault’s colour when the sensor read that would refresh it failed', () => {
    // A critical sensor does not stop being critical because the controller
    // went quiet, so the stale count still paints the card.
    const presentation = describeState(
      stateWith({
        power: 'on',
        sensors: sensorsWith({ bad: 1, total: 18, problem: 'The sensors could not be read.' })
      })
    )

    expect(presentation.status).toBe('bad')
    expect(presentation.summary).toBe('Power on · 1 sensor critical, sensors unread')
  })
})

describe('buildMachinesPayload(): what a rack full of them adds up to', () => {
  const states = (entries: ReadonlyArray<[string, MachineRuntimeState]>): Map<string, MachineRuntimeState> =>
    new Map(entries)

  it('counts parked machines as disabled and leaves them out of the monitored denominator', () => {
    const config = configOf([{}, { enabled: false }, {}])
    const payload = buildMachinesPayload(
      config,
      states([
        ['m1', stateWith({ revision: 'r1' })],
        ['m2', stateWith({ revision: 'r2' })],
        ['m3', stateWith({ revision: 'r3' })]
      ])
    )

    expect(payload.counts.total).toBe(3)
    expect(payload.counts.disabled).toBe(1)
    expect(payload.counts.monitored).toBe(2)
  })

  it('never files a parked machine under a power or reachability bucket, whatever was last heard from it', () => {
    // Its last reading is from before it was parked; letting it stay in
    // `unreachable` would keep an endpoint the user told the module to stop
    // touching lit up as a fault.
    const config = configOf([{ enabled: false }])
    const payload = buildMachinesPayload(
      config,
      states([['m1', stateWith({ revision: 'r1', reach: 'timeout', power: null, sensors: sensorsWith({ bad: 4 }) })]])
    )

    expect(payload.counts).toMatchObject({
      on: 0,
      off: 0,
      unreachable: 0,
      authFailed: 0,
      unknown: 0,
      monitored: 0,
      disabled: 1,
      sensorsBad: 0,
      healthLevel: 0,
      healthPct: 100
    })
    expect(payload.machines[0].status).toBe('unknown')
    expect(payload.machines[0].powerLabel).toBe('Sweeping disabled')
  })

  it('raises healthLevel to 2 as soon as one monitored machine is critical', () => {
    const config = configOf([{}, {}, {}])
    const payload = buildMachinesPayload(
      config,
      states([
        ['m1', stateWith({ revision: 'r1', sensors: sensorsWith({ bad: 1 }) })],
        ['m2', stateWith({ revision: 'r2', sensors: sensorsWith({ warn: 2 }) })],
        ['m3', stateWith({ revision: 'r3', sensors: sensorsWith() })]
      ])
    )

    expect(payload.counts.healthLevel).toBe(2)
    expect(payload.counts.critical).toBe(1)
    expect(payload.counts.warning).toBe(1)
    expect(payload.counts.healthy).toBe(1)
  })

  it('settles at healthLevel 1 when the worst finding is a warning, and 0 when there is none', () => {
    const config = configOf([{}, {}])
    const warned = buildMachinesPayload(
      config,
      states([
        ['m1', stateWith({ revision: 'r1', sensors: sensorsWith({ warn: 1 }) })],
        ['m2', stateWith({ revision: 'r2', sensors: sensorsWith() })]
      ])
    )
    expect(warned.counts.healthLevel).toBe(1)

    const clean = buildMachinesPayload(
      config,
      states([
        ['m1', stateWith({ revision: 'r1', sensors: sensorsWith() })],
        ['m2', stateWith({ revision: 'r2', sensors: sensorsWith() })]
      ])
    )
    expect(clean.counts.healthLevel).toBe(0)
  })

  it('rounds healthPct down, so "2 of 3 healthy" never reads as 67 % of a rack that is not', () => {
    const config = configOf([{}, {}, {}])
    const payload = buildMachinesPayload(
      config,
      states([
        ['m1', stateWith({ revision: 'r1', sensors: sensorsWith({ bad: 1 }) })],
        ['m2', stateWith({ revision: 'r2', sensors: sensorsWith() })],
        ['m3', stateWith({ revision: 'r3', sensors: sensorsWith() })]
      ])
    )

    expect(payload.counts.healthy).toBe(2)
    expect(payload.counts.monitored).toBe(3)
    expect(payload.counts.healthPct).toBe(66)
  })

  it('reports 100 % health when nothing is monitored, rather than dividing by zero', () => {
    const payload = buildMachinesPayload(configOf([{ enabled: false }, { enabled: false }]), new Map())

    expect(payload.counts.monitored).toBe(0)
    expect(payload.counts.healthPct).toBe(100)
    expect(payload.counts.healthLevel).toBe(0)
  })

  it('sums the fleet sensor counts across monitored machines only', () => {
    const config = configOf([{}, { enabled: false }, {}])
    const payload = buildMachinesPayload(
      config,
      states([
        ['m1', stateWith({ revision: 'r1', sensors: sensorsWith({ bad: 1, warn: 2 }) })],
        ['m2', stateWith({ revision: 'r2', sensors: sensorsWith({ bad: 9, warn: 9 }) })],
        ['m3', stateWith({ revision: 'r3', sensors: sensorsWith({ bad: 0, warn: 3 }) })]
      ])
    )

    expect(payload.counts.sensorsBad).toBe(1)
    expect(payload.counts.sensorsWarn).toBe(5)
  })

  it('buckets reachable machines by power and unreachable ones by how they failed', () => {
    const config = configOf([{}, {}, {}, {}])
    const payload = buildMachinesPayload(
      config,
      states([
        ['m1', stateWith({ revision: 'r1', power: 'on' })],
        ['m2', stateWith({ revision: 'r2', power: 'off' })],
        ['m3', stateWith({ revision: 'r3', power: null, reach: 'auth' })],
        ['m4', stateWith({ revision: 'r4', power: null, reach: 'timeout' })]
      ])
    )

    expect(payload.counts).toMatchObject({ on: 1, off: 1, authFailed: 1, unreachable: 1, unknown: 0 })
  })

  it('ignores a reading taken against a machine’s previous revision', () => {
    // The user re-pointed or re-credentialed the entry; the answer in hand
    // came from the old endpoint and is not about this machine any more.
    const payload = buildMachinesPayload(
      configOf([{}]),
      states([['m1', stateWith({ revision: 'r-old', power: 'on' })]])
    )

    expect(payload.machines[0].status).toBe('unknown')
    expect(payload.machines[0].powerLabel).toBe('Not checked yet')
    expect(payload.counts.unknown).toBe(1)
  })
})

/* ------------------------------------------------------------------------ */
/* The sweep itself, driven through the module harness.                      */
/* ------------------------------------------------------------------------ */

const IPMITOOL_VERSION = 'ipmitool version 1.8.18\n'
const POWER_ON = 'Chassis Power is on\n'
const POWER_OFF = 'Chassis Power is off\n'

/** `ipmitool sdr elist` on a healthy chassis: one `ns` row the parser cannot read. */
const SDR_HEALTHY = [
  'SEL              | 72h | ns  |  7.1 | No Reading',
  'Intrusion        | 73h | ok  |  7.1 |',
  'Fan1 RPM         | 30h | ok  |  7.1 | 3720 RPM',
  'Fan2 RPM         | 31h | ok  |  7.1 | 3600 RPM',
  'Inlet Temp       | 04h | ok  |  7.1 | 23 degrees C',
  'Exhaust Temp     | 01h | ok  |  7.1 | 35 degrees C',
  'Pwr Consumption  | 77h | ok  | 10.1 | 168 Watts',
  ''
].join('\n')

/** The same chassis with a stopped fan: IPMI's own `cr` threshold word. */
const SDR_FAN_CRITICAL = SDR_HEALTHY.replace(
  'Fan2 RPM         | 31h | ok  |  7.1 | 3600 RPM',
  'Fan2 RPM         | 31h | cr  |  7.1 | 0 RPM'
)

const SDR_ERROR = 'Error: Unable to establish IPMI v2 / RMCP+ session\n'

interface HostFixture {
  power: string
  sdr: string
  sdrCode: number
}

function hostFixture(overrides: Partial<HostFixture> = {}): HostFixture {
  return { power: POWER_ON, sdr: SDR_HEALTHY, sdrCode: 0, ...overrides }
}

/**
 * The exec fixture routes on the command string, because that is all the
 * module gives a management machine: one shell line per read, with the BMC's
 * address quoted into it.
 */
function answerFor(hosts: Readonly<Record<string, HostFixture>>): (command: string) => ModuleExecResult {
  return (command) => {
    if (command.includes('ipmitool -V')) return { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }

    const ip = Object.keys(hosts).find((candidate) => command.includes(`-H '${candidate}'`))
    const host = ip ? hosts[ip] : undefined
    if (!host) return { stdout: '', stderr: `no fixture for: ${command}`, code: 1 }

    if (command.includes('chassis power status')) {
      return { stdout: host.power, stderr: '', code: 0 }
    }
    if (command.includes('sdr elist')) {
      return host.sdrCode === 0
        ? { stdout: host.sdr, stderr: '', code: 0 }
        : { stdout: '', stderr: SDR_ERROR, code: host.sdrCode }
    }
    return { stdout: '', stderr: `unexpected command: ${command}`, code: 1 }
  }
}

function commandsOf(harness: ModuleHarness): string[] {
  return harness.exec.mock.calls.map((call) => call[0])
}

function countOf(harness: ModuleHarness, fragment: string): number {
  return commandsOf(harness).filter((command) => command.includes(fragment)).length
}

function lastMachines(harness: ModuleHarness): MachinesPayload {
  const calls = harness.emit.mock.calls as unknown as ReadonlyArray<readonly [string, unknown]>
  const last = calls.filter((call) => call[0] === 'machines').at(-1)
  if (!last) throw new Error('the module never emitted a machines payload')
  return last[1] as MachinesPayload
}

/**
 * A manual sweep, which is also the only way to run one deterministically:
 * it probes the management machine first and awaits the whole pass, where the
 * poller merely schedules it.
 */
async function sweepNow(harness: ModuleHarness): Promise<void> {
  const handler = harness.handlers.get('sweepNow')
  if (!handler) throw new Error('the module never registered a sweepNow handler')
  await handler()
}

/**
 * Which machines have a usable password, and which have a broken one.
 *
 * Every entry gets a saved credential unless a test says otherwise, because
 * that is the ordinary case and a sweep against a machine with no password
 * never reaches the network at all.
 */
interface CredentialFixture {
  /** Machine ids with nothing in the secret store - the user never entered one. */
  missing?: readonly string[]
  /** Machine ids whose stored secret this install can no longer decrypt. */
  unreadable?: readonly string[]
}

function bmcHarness(
  hosts: Readonly<Record<string, HostFixture>>,
  machines: ReadonlyArray<Partial<BmcMachine>>,
  settings: Partial<BmcSettings> = {},
  credentials: CredentialFixture = {}
): ModuleHarness {
  const missing = new Set(credentials.missing ?? [])
  const ids = machines.map((entry, index) => entry.id ?? `m${index + 1}`)
  const harness = moduleHarness('bmc', answerFor(hosts), {
    config: sharedModuleConfig(doc(machines, settings)),
    secrets: Object.fromEntries(
      ids.filter((id) => !missing.has(id)).map((id) => [`machine/${id}`, 'secret'])
    ),
    // An unreadable secret is stored and undecryptable, which is what happens
    // when `data/secret.key` is replaced - so it is seeded above as well.
    unreadableSecrets: (credentials.unreadable ?? []).map((id) => `machine/${id}`)
  })
  activateBmc(harness.ctx)
  return harness
}

/** The settings table, which is where a credential problem is named per row. */
async function machineRows(harness: ModuleHarness): Promise<MachineRow[]> {
  const handler = harness.handlers.get('machineRows')
  if (!handler) throw new Error('the module never registered a machineRows handler')
  return (await handler()) as MachineRow[]
}

describe('the sweep: what it asks each machine', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('asks each enabled machine for its power state exactly once and never speaks to a parked one', async () => {
    const harness = bmcHarness(
      {
        '10.0.0.5': hostFixture(),
        '10.0.0.6': hostFixture(),
        '10.0.0.7': hostFixture()
      },
      [{}, { enabled: false }, {}]
    )

    await sweepNow(harness)

    expect(countOf(harness, 'chassis power status')).toBe(2)
    expect(commandsOf(harness).some((command) => command.includes("-H '10.0.0.6'"))).toBe(false)
  })

  it('reads sensors on every sweep when sensorEverySweeps is 1', async () => {
    const harness = bmcHarness({ '10.0.0.5': hostFixture() }, [{}], { sensorEverySweeps: 1 })

    await sweepNow(harness)
    await sweepNow(harness)

    expect(countOf(harness, 'chassis power status')).toBe(2)
    expect(countOf(harness, 'sdr elist')).toBe(2)
  })

  it('never reads sensors when sensorEverySweeps is 0, and paints the card from power alone', async () => {
    // The fixture would report a stopped fan if it were ever asked. Turning
    // sensor folding off is a deliberate return to power-only health, so the
    // card is green and carries no sensor chips at all.
    const harness = bmcHarness({ '10.0.0.5': hostFixture({ sdr: SDR_FAN_CRITICAL }) }, [{}], {
      sensorEverySweeps: 0
    })

    await sweepNow(harness)

    expect(countOf(harness, 'sdr elist')).toBe(0)
    const card = lastMachines(harness).machines[0]
    expect(card.status).toBe('ok')
    expect(card.summary).toBe('Power on')
    expect(card.chips.map((chip) => chip.label)).toEqual(['10.0.0.5', 'Power on', 'seen'])
  })

  it('leaves the sensor read alone while the last one is still fresh, and takes it again once it is not', async () => {
    // The cadence is a time, not a counter: sensorEverySweeps 3 at a 60 s slow
    // interval is 150 s (three intervals less half a one of slack), so a
    // second sweep pressed straight after the first must not pay for sensors
    // it just read.
    vi.useFakeTimers()
    const start = Date.UTC(2026, 7, 30, 9, 0, 0)
    vi.setSystemTime(start)

    const harness = bmcHarness({ '10.0.0.5': hostFixture() }, [{}])
    expect(harness.ctx.slowIntervalSec('bmc')).toBe(60)

    await sweepNow(harness)
    expect(countOf(harness, 'sdr elist')).toBe(1)

    await sweepNow(harness)
    expect(countOf(harness, 'sdr elist')).toBe(1)

    vi.setSystemTime(start + 149_000)
    await sweepNow(harness)
    expect(countOf(harness, 'sdr elist')).toBe(1)

    vi.setSystemTime(start + 151_000)
    await sweepNow(harness)
    expect(countOf(harness, 'sdr elist')).toBe(2)
    expect(countOf(harness, 'chassis power status')).toBe(4)
  })
})

describe('the sweep: what a sensor reading does to a card', () => {
  it('turns a powered-on machine red when the SDR reports a critical row', async () => {
    const harness = bmcHarness({ '10.0.0.5': hostFixture({ sdr: SDR_FAN_CRITICAL }) }, [{}], {
      sensorEverySweeps: 1
    })

    await sweepNow(harness)

    const payload = lastMachines(harness)
    const card = payload.machines[0]
    expect(card.status).toBe('bad')
    expect(card.powerLabel).toBe('Power on')
    expect(card.summary).toBe('Power on · 1 sensor critical')
    expect(card.chips).toContainEqual({ label: 'Fan2 RPM 0 RPM', status: 'bad', pinned: true })
    expect(payload.counts.on).toBe(1)
    expect(payload.counts.sensorsBad).toBe(1)
    expect(payload.counts.healthLevel).toBe(2)
  })

  it('stays green on a healthy chassis even though one SDR row was unreadable', async () => {
    const harness = bmcHarness({ '10.0.0.5': hostFixture() }, [{}], { sensorEverySweeps: 1 })

    await sweepNow(harness)

    const card = lastMachines(harness).machines[0]
    expect(card.status).toBe('ok')
    // Seven rows parsed, of which the `ns` SEL row has no status. It is
    // counted and shown and never folded into the colour - and it is also not
    // counted among the ones certified ok, because a card that vouches for a
    // row nobody could read overstates health in the other direction.
    expect(card.chips).toContainEqual({ label: '6 sensors ok', status: 'ok', pinned: false })
    expect(card.chips).toContainEqual({ label: '1 not reporting', status: 'unknown', pinned: true })
  })

  it('keeps the previous counts and says plainly that they are not current when the SDR read fails', async () => {
    const host = hostFixture()
    const harness = bmcHarness({ '10.0.0.5': host }, [{}], { sensorEverySweeps: 1 })

    await sweepNow(harness)
    host.sdrCode = 1
    await sweepNow(harness)

    const card = lastMachines(harness).machines[0]
    expect(card.chips).toContainEqual({ label: '6 sensors ok', status: 'ok', pinned: false })
    expect(card.chips).toContainEqual({ label: 'Sensors unread', status: 'unknown', pinned: true })
    expect(card.summary).toBe('Power on · sensors unread')
  })

  it('does not leave a card green on sensor readings nobody has confirmed since', async () => {
    const host = hostFixture()
    const harness = bmcHarness({ '10.0.0.5': host }, [{}], { sensorEverySweeps: 1 })

    await sweepNow(harness)
    expect(lastMachines(harness).machines[0].status).toBe('ok')

    host.sdrCode = 1
    await sweepNow(harness)

    const card = lastMachines(harness).machines[0]
    expect(card.status).not.toBe('ok')
    expect(card.status).toBe('unknown')
  })

  it('keeps a critical machine red when the read that would have cleared it failed', async () => {
    // The other half of the same rule: a stopped fan does not stop being a
    // stopped fan because the controller went quiet.
    const host = hostFixture({ sdr: SDR_FAN_CRITICAL })
    const harness = bmcHarness({ '10.0.0.5': host }, [{}], { sensorEverySweeps: 1 })

    await sweepNow(harness)
    host.sdrCode = 1
    await sweepNow(harness)

    const card = lastMachines(harness).machines[0]
    expect(card.status).toBe('bad')
    expect(card.summary).toBe('Power on · 1 sensor critical, sensors unread')
  })

  it('reports a machine that is off as unknown rather than as a fault, and still sweeps its neighbour', async () => {
    const harness = bmcHarness(
      {
        '10.0.0.5': hostFixture({ power: POWER_OFF }),
        '10.0.0.6': hostFixture()
      },
      [{}, {}],
      { sensorEverySweeps: 1 }
    )

    await sweepNow(harness)

    const payload = lastMachines(harness)
    expect(payload.machines[0].status).toBe('unknown')
    expect(payload.machines[0].powerLabel).toBe('Power off')
    expect(payload.machines[1].status).toBe('ok')
    expect(payload.counts).toMatchObject({ on: 1, off: 1, healthLevel: 0, healthPct: 100 })
  })
})

/**
 * A machine the module has no usable password for.
 *
 * Since 0.6.0 the password is not in the settings document at all - it is
 * fetched from the app's encrypted secret store at the point of use - so there
 * are two new ways for a machine to have no credential: nobody ever entered
 * one, and `data/secret.key` was replaced so the stored one can no longer be
 * decrypted. Both are authentication problems, and both are settled before
 * anything reaches the network: authenticating with nothing, once a minute,
 * against a controller that locks accounts for it is the outcome to avoid.
 */
const NO_PASSWORD_SAVED =
  'No password is saved for this BMC. Open its row on the Module settings page and enter one.'

const PASSWORD_UNREADABLE =
  "The saved password for this BMC cannot be read - the app's secret key is not the one it was written with. Open its row on the Module settings page and enter it again."

describe('the sweep: a machine with no usable password', () => {
  it('reports a machine with nothing in the secret store as an auth failure, without asking the network', async () => {
    const harness = bmcHarness({ '10.0.0.5': hostFixture() }, [{}], { sensorEverySweeps: 1 }, {
      missing: ['m1']
    })

    await sweepNow(harness)

    const payload = lastMachines(harness)
    // Amber, not red: the fault is in this module's own settings, and sending
    // somebody to check cabling for a password they never typed is the wrong
    // place to send them.
    expect(payload.machines[0].status).toBe('warn')
    expect(payload.machines[0].powerLabel).toBe(failureLabel('auth'))
    expect(payload.counts).toMatchObject({ monitored: 1, authFailed: 1, on: 0, healthLevel: 1 })

    // Not one ipmitool invocation against the BMC - not the power read and not
    // the sensor read either, even though sensors were due this sweep.
    expect(commandsOf(harness).some((command) => command.includes("-H '10.0.0.5'"))).toBe(false)
    expect(countOf(harness, 'chassis power status')).toBe(0)
    expect(countOf(harness, 'sdr elist')).toBe(0)
  })

  it('names the missing password in the row, so the settings page says what to do about it', async () => {
    const harness = bmcHarness({ '10.0.0.5': hostFixture() }, [{}], {}, { missing: ['m1'] })

    await sweepNow(harness)

    // `lastError` is the credential's own sentence, carried through to the
    // table's problem column - a card that just says "Auth failed" leaves the
    // user checking a password that is not there to be wrong.
    expect((await machineRows(harness))[0]).toMatchObject({
      credential: 'missing',
      auth: 'no password',
      powerLabel: 'Auth failed',
      problem: NO_PASSWORD_SAVED
    })
  })

  it('treats a stored password this install can no longer decrypt exactly the same way', async () => {
    // The secret is there; the key that would open it is not. Reading that as
    // "no password" and carrying on would be the same wrong answer with a
    // worse sentence attached.
    const harness = bmcHarness({ '10.0.0.5': hostFixture() }, [{}], { sensorEverySweeps: 1 }, {
      unreadable: ['m1']
    })

    await sweepNow(harness)

    const payload = lastMachines(harness)
    expect(payload.machines[0].status).toBe('warn')
    expect(payload.machines[0].powerLabel).toBe(failureLabel('auth'))
    expect(payload.counts.authFailed).toBe(1)
    expect(commandsOf(harness).some((command) => command.includes("-H '10.0.0.5'"))).toBe(false)
  })

  it('tells the user to enter it again rather than to enter one, because those are different problems', async () => {
    const harness = bmcHarness({ '10.0.0.5': hostFixture() }, [{}], {}, { unreadable: ['m1'] })

    await sweepNow(harness)

    expect((await machineRows(harness))[0]).toMatchObject({
      credential: 'unreadable',
      auth: 'enter it again',
      problem: PASSWORD_UNREADABLE
    })
    expect(PASSWORD_UNREADABLE).not.toBe(NO_PASSWORD_SAVED)
  })

  it('sweeps the machines that do have a password and skips only the one that does not', async () => {
    const harness = bmcHarness(
      { '10.0.0.5': hostFixture(), '10.0.0.6': hostFixture(), '10.0.0.7': hostFixture() },
      [{}, {}, {}],
      { sensorEverySweeps: 1 },
      { missing: ['m2'] }
    )

    await sweepNow(harness)

    // One entry with no credential does not cost the rack its sweep.
    expect(countOf(harness, 'chassis power status')).toBe(2)
    expect(commandsOf(harness).some((command) => command.includes("-H '10.0.0.6'"))).toBe(false)

    const payload = lastMachines(harness)
    expect(payload.machines.map((card) => card.status)).toEqual(['ok', 'warn', 'ok'])
    expect(payload.counts).toMatchObject({ monitored: 3, on: 2, authFailed: 1, healthLevel: 1 })
  })

  it('says nothing about a parked machine with no password, because nothing is being asked of it', async () => {
    const harness = bmcHarness(
      { '10.0.0.5': hostFixture() },
      [{ enabled: false }],
      {},
      { missing: ['m1'] }
    )

    await sweepNow(harness)

    const payload = lastMachines(harness)
    expect(payload.machines[0].powerLabel).toBe('Sweeping disabled')
    expect(payload.counts).toMatchObject({ disabled: 1, monitored: 0, authFailed: 0, healthLevel: 0 })
  })
})
