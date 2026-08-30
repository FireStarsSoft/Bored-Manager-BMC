import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type {
  ModuleContext,
  ModuleExecResult,
  ModuleHistoryPoint,
  ModuleManifest
} from '@shared/modules'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import activateBmc from '../../bmc/main/index'
import {
  buildMachinesPayload,
  pointFrom,
  SeriesLog,
  type MachineRuntimeState,
  type MachinesPayload,
  type SensorHealth,
  type SeriesPoint
} from '../../bmc/main/sweep'
import {
  DEFAULT_SETTINGS,
  normalize,
  type BmcConfig,
  type BmcMachine,
  type BmcSettings
} from '../../bmc/main/store'

/**
 * The series log: one point per sweep, sent live to whatever chart is open and
 * written to the metrics archive on disk.
 *
 * Two things make this worth its own file. The first is that a point is the
 * only record of a sweep that outlives it - a card is repainted on the next
 * pass, so "when did this start?" can only ever be answered from here. The
 * second is that the point and the cards are built from the same payload and
 * published a line apart, and nothing but a test stops them drifting: a chart
 * that says four machines were unreachable while the cards below it show two
 * discredits both.
 */

/**
 * Mirrors SERIES_WINDOW_MS in bmc/main/sweep/history.ts, which is module-local.
 * Nothing below repeats the number: the boundary tests pin it from both sides,
 * so if the source window changes and this does not, they fail rather than
 * quietly measuring the wrong thing.
 */
const SERIES_WINDOW_MS = 5 * 60 * 1000

/** The event the module publishes a point under; also what its manifest must declare. */
const SERIES_EVENT = 'series'

/** A fixed sweep time, so a point's `t` can be told apart from "now". */
const T0 = Date.UTC(2026, 7, 30, 9, 0, 0)

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                 */
/* ------------------------------------------------------------------------ */

function sensorsWith(partial: Partial<SensorHealth> = {}): SensorHealth {
  return { at: T0, bad: 0, warn: 0, unknown: 0, total: 24, worst: [], ...partial }
}

function stateWith(partial: Partial<MachineRuntimeState> = {}): MachineRuntimeState {
  return { revision: 'r1', power: 'on', reach: 'ok', lastSeen: T0, sensors: null, draw: null,
    clock: null, ...partial }
}

/** A settings document as it sits on disk, read back through the real reader. */
function doc(machines: ReadonlyArray<Partial<BmcMachine>>, settings: Partial<BmcSettings> = {}): unknown {
  return {
    version: 2,
    hintsOn: true,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    machines: machines.map((entry, index) => ({
      id: `m${index + 1}`,
      revision: `r${index + 1}`,
      name: `Server ${index + 1}`,
      ip: `10.0.0.${index + 5}`,
      port: 623,
      username: 'admin',
      password: 'secret',
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

/**
 * The seven counts a point carries, all different on purpose: with a rack where
 * `off` and `unreachable` both happen to be 1, a point that read one bucket
 * into the other's series would still match every assertion below.
 */
const FLEET = {
  on: 1,
  off: 2,
  unreachable: 3,
  authFailed: 4,
  sensorsWarn: 5,
  sensorsBad: 6,
  watts: 7
} as const

/** A rack with one of everything, swept at `timestamp`. */
function distinctFleet(timestamp: number): MachinesPayload {
  const entries: Array<Partial<BmcMachine>> = []
  const states = new Map<string, MachineRuntimeState>()
  const add = (state: MachineRuntimeState, machine: Partial<BmcMachine> = {}): void => {
    const index = entries.length + 1
    entries.push(machine)
    states.set(`m${index}`, { ...state, revision: `r${index}` })
  }

  // Every faulty sensor in the fleet sits on the one machine that is up, which
  // is the realistic case: a controller has to answer to report a bad fan.
  add(
    stateWith({
      power: 'on',
      sensors: sensorsWith({ warn: FLEET.sensorsWarn, bad: FLEET.sensorsBad }),
      draw: { watts: FLEET.watts, supported: true }
    })
  )
  for (let i = 0; i < FLEET.off; i += 1) add(stateWith({ power: 'off' }))
  for (let i = 0; i < FLEET.unreachable; i += 1) {
    add(stateWith({ power: null, reach: 'timeout', lastSeen: null }))
  }
  for (let i = 0; i < FLEET.authFailed; i += 1) {
    add(stateWith({ power: null, reach: 'auth', lastSeen: null }))
  }
  // A parked machine whose last reading was alarming: nothing about it may
  // reach the chart, because nothing is asking it anything any more.
  add(
    stateWith({
      power: null,
      reach: 'unreachable',
      sensors: sensorsWith({ bad: 9, warn: 9 }),
      draw: { watts: 999, supported: true }
    }),
    { enabled: false }
  )

  return buildMachinesPayload(configOf(entries), states, timestamp)
}

/* ------------------------------------------------------------------------ */
/* pointFrom()                                                              */
/* ------------------------------------------------------------------------ */

describe('pointFrom(): what one sweep leaves behind for the chart and the archive', () => {
  it('carries the sweep timestamp and exactly the seven counts a chart plots, and nothing else', () => {
    // The key set is the wire format of the archive: the two sensor keys are
    // additive in 2.0.0, so the four power keys must keep their old names for
    // a chart spec that names only those, and no derived fleet figure may
    // appear beside them - `healthPct` is a verdict, not a measurement, and a
    // point that carried one would have it plotted for hours after the rule
    // that produced it changed.
    const point = pointFrom(distinctFleet(T0))

    expect(Object.keys(point).sort()).toEqual([
      'authFailed',
      'off',
      'on',
      'sensorsBad',
      'sensorsWarn',
      't',
      'unreachable',
      'watts'
    ])
  })

  it('takes each count out of its own bucket, so no two series can be swapped', () => {
    expect(pointFrom(distinctFleet(T0))).toEqual({ t: T0, ...FLEET })
  })

  it('leaves out the counts that describe the rack rather than a moment in it', () => {
    const payload = distinctFleet(T0)
    const carried = Object.keys(pointFrom(payload))

    // All present on the payload the point was built from, all deliberately
    // absent from it: total and monitored describe the configuration, and
    // healthPct/healthLevel are how this version chose to colour it.
    for (const key of ['total', 'disabled', 'monitored', 'unknown', 'healthy', 'healthPct', 'healthLevel']) {
      expect(payload.counts).toHaveProperty(key)
      expect(carried).not.toContain(key)
    }
  })

  it('stamps the point with the time of the sweep, not the time the point was made', () => {
    // The payload is the only clock here. A point that took its own `Date.now()`
    // would file a slow sweep's readings minutes after the pass they came from.
    const swept = T0 - 47 * 60 * 1000

    expect(pointFrom(distinctFleet(swept)).t).toBe(swept)
  })

  it('carries nothing but finite numbers, which is all the metrics archive can hold', () => {
    // ModuleHistoryPoint is `t` plus numbers. A NaN from an empty rack would
    // be written, stored, and drawn as a hole nobody can explain later.
    for (const value of Object.values(pointFrom(distinctFleet(T0)))) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('reports an empty rack as zeroes rather than as a gap in the chart', () => {
    const point = pointFrom(buildMachinesPayload(configOf([]), new Map(), T0))

    expect(point).toEqual({
      t: T0,
      on: 0,
      off: 0,
      unreachable: 0,
      authFailed: 0,
      sensorsWarn: 0,
      sensorsBad: 0,
      watts: 0
    })
  })
})

/* ------------------------------------------------------------------------ */
/* SeriesLog                                                                */
/* ------------------------------------------------------------------------ */

interface SeriesProbe {
  ctx: ModuleContext
  emit: ReturnType<typeof vi.fn<(event: string, payload: unknown) => void>>
  addHistory: ReturnType<typeof vi.fn<(point: ModuleHistoryPoint, stream?: string) => void>>
}

/**
 * SeriesLog touches exactly two members of its context, so standing them up by
 * hand is honest rather than a shortcut - and it is the only way to watch
 * `addHistory` at all, since the shared harness keeps that mock to itself.
 */
function seriesProbe(): SeriesProbe {
  const emit = vi.fn<(event: string, payload: unknown) => void>()
  const addHistory = vi.fn<(point: ModuleHistoryPoint, stream?: string) => void>()
  return { ctx: { emit, addHistory } as unknown as ModuleContext, emit, addHistory }
}

function seriesEmits(probe: SeriesProbe): SeriesPoint[] {
  return probe.emit.mock.calls
    .filter((call) => call[0] === SERIES_EVENT)
    .map((call) => call[1] as SeriesPoint)
}

describe('SeriesLog: the live tail a freshly opened browser is seeded with', () => {
  it('publishes each point once, and hands back the same object it stored', () => {
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)
    const payload = distinctFleet(T0)

    const point = log.append(payload)

    expect(probe.emit.mock.calls).toHaveLength(1)
    expect(probe.emit.mock.calls[0][0]).toBe(SERIES_EVENT)
    expect(probe.emit.mock.calls[0][1]).toBe(point)
    expect(log.points).toEqual([pointFrom(payload)])
    expect(log.points[0]).toBe(point)
  })

  it('writes the same numbers to the archive that it sent to the chart', () => {
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)

    const point = log.append(distinctFleet(T0))

    expect(probe.addHistory.mock.calls).toHaveLength(1)
    expect(probe.addHistory.mock.calls[0][0]).toEqual(point)
  })

  it('names no stream, so the point lands in the module’s own history stream', () => {
    // `addHistory(point)` defaults to the module id. Passing a name would mean
    // declaring it in the manifest as well; the test below checks the default
    // one actually is declared.
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)

    log.append(distinctFleet(T0))

    expect(probe.addHistory.mock.calls[0]).toHaveLength(1)
  })

  it('gives the archive a copy, so neither side can rewrite the other’s numbers', () => {
    // The archive keeps a point for hours and the tail keeps it for five
    // minutes; sharing one object between them lets a later edit of either
    // silently change what a chart already drew.
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)

    const point = log.append(distinctFleet(T0))
    const written = probe.addHistory.mock.calls[0][0]

    expect(written).not.toBe(point)

    written.on += 1
    expect(log.points[0].on).toBe(FLEET.on)

    log.points[0].off += 1
    expect(written.off).toBe(FLEET.off)
  })

  it('keeps a point that is exactly the window old, and drops the one behind it', () => {
    // The cutoff is the newest point's own time less the window, so the edge
    // is inclusive: a five-minute chart that dropped the point five minutes
    // back would open one sample short of the range it advertises.
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)

    log.append(distinctFleet(T0))
    log.append(distinctFleet(T0 + SERIES_WINDOW_MS))
    expect(log.points.map((point) => point.t)).toEqual([T0, T0 + SERIES_WINDOW_MS])

    log.append(distinctFleet(T0 + SERIES_WINDOW_MS + 1))
    expect(log.points.map((point) => point.t)).toEqual([
      T0 + SERIES_WINDOW_MS,
      T0 + SERIES_WINDOW_MS + 1
    ])
  })

  it('drops every point that has fallen out of the window, not just the oldest one', () => {
    // A sweep that runs after a long gap - a laptop that was asleep - retires
    // a whole tail at once, and a log that shifted one point per append would
    // keep serving samples from before the gap.
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)

    for (const offset of [0, 1_000, 2_000, 3_000]) log.append(distinctFleet(T0 + offset))
    expect(log.points).toHaveLength(4)

    log.append(distinctFleet(T0 + SERIES_WINDOW_MS + 4_000))

    expect(log.points.map((point) => point.t)).toEqual([T0 + SERIES_WINDOW_MS + 4_000])
  })

  it('still publishes a point it does not keep, because the chart and the tail are different jobs', () => {
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)

    log.append(distinctFleet(T0))
    log.append(distinctFleet(T0 + SERIES_WINDOW_MS + 1))
    log.append(distinctFleet(T0 + SERIES_WINDOW_MS + 2))

    expect(seriesEmits(probe)).toHaveLength(3)
    expect(probe.addHistory.mock.calls).toHaveLength(3)
    expect(log.points).toHaveLength(2)
  })

  it('keeps the tail in the order the sweeps happened, oldest first', () => {
    // The tail is handed to a browser as-is and drawn left to right; a chart
    // fed an unordered ring draws a line that doubles back on itself.
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)
    const offsets = [0, 30_000, 60_000, 90_000, 120_000]

    for (const offset of offsets) log.append(distinctFleet(T0 + offset))

    expect(log.points.map((point) => point.t)).toEqual(offsets.map((offset) => T0 + offset))
    expect(log.points.at(-1)?.t).toBe(T0 + 120_000)
  })

  it('empties the tail on reset without publishing anything of its own', () => {
    // Reset is a local forget - the module is being re-seeded, and a browser
    // that is about to ask for a fresh snapshot must not be sent an empty one
    // first, nor the archive a point nothing measured.
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)
    log.append(distinctFleet(T0))
    log.append(distinctFleet(T0 + 1_000))

    log.reset()

    expect(log.points).toEqual([])
    expect(seriesEmits(probe)).toHaveLength(2)
    expect(probe.addHistory.mock.calls).toHaveLength(2)
  })

  it('starts a fresh window after a reset rather than staying wedged', () => {
    const probe = seriesProbe()
    const log = new SeriesLog(probe.ctx)
    log.append(distinctFleet(T0))
    log.reset()

    const point = log.append(distinctFleet(T0 + 1_000))

    expect(log.points).toEqual([point])
    expect(seriesEmits(probe)).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------------ */
/* A whole sweep, through the module harness                                */
/* ------------------------------------------------------------------------ */

const ok = (stdout: string): ModuleExecResult => ({ stdout, stderr: '', code: 0 })
const failed = (stderr: string, code = 1): ModuleExecResult => ({ stdout: '', stderr, code })

const IPMITOOL_PRESENT = ok('ipmitool version 1.8.18\n')
const IPMITOOL_MISSING = ok('missing\n')

const POWER_ON = ok('Chassis Power is on\n')
const POWER_OFF = ok('Chassis Power is off\n')
/** ipmitool's own words for silence on UDP 623, and for a refused login. */
const NO_SESSION = failed('Error: Unable to establish IPMI v2 / RMCP+ session\n')
const BAD_PASSWORD = failed('Error: RAKP 2 HMAC is invalid\n')

/** `ipmitool sdr elist` on a healthy chassis; one `ns` row the parser cannot read. */
const SDR_HEALTHY = ok(
  [
    'SEL              | 72h | ns  |  7.1 | No Reading',
    'Fan1 RPM         | 30h | ok  |  7.1 | 3720 RPM',
    'Fan2 RPM         | 31h | ok  |  7.1 | 3600 RPM',
    'Inlet Temp       | 04h | ok  |  7.1 | 23 degrees C',
    'Pwr Consumption  | 77h | ok  | 10.1 | 168 Watts',
    ''
  ].join('\n')
)

/** The same chassis with one stopped fan and two rails outside their warning band. */
const SDR_FAULTY = ok(
  [
    'SEL              | 72h | ns  |  7.1 | No Reading',
    'Fan1 RPM         | 30h | ok  |  7.1 | 3720 RPM',
    'Fan2 RPM         | 31h | cr  |  7.1 | 0 RPM',
    'Inlet Temp       | 04h | nc  |  7.1 | 47 degrees C',
    'Exhaust Temp     | 01h | nc  |  7.1 | 71 degrees C',
    ''
  ].join('\n')
)

interface HostFixture {
  power: ModuleExecResult
  sdr: ModuleExecResult
}

interface Rack {
  tool: ModuleExecResult
  hosts: Record<string, HostFixture>
}

/**
 * The exec fixture routes on the command string, because that is all the
 * module gives a management machine: one shell line per read, with the BMC's
 * address quoted into it.
 */
function answerFor(rack: Rack): (command: string) => ModuleExecResult {
  return (command) => {
    if (command.includes('command -v ipmitool')) return rack.tool

    const ip = Object.keys(rack.hosts).find((candidate) => command.includes(`-H '${candidate}'`))
    const host = ip ? rack.hosts[ip] : undefined
    if (!host) return failed(`no fixture for: ${command}`)
    if (command.includes('chassis power status')) return host.power
    if (command.includes('sdr elist')) return host.sdr
    return failed(`unexpected command: ${command}`)
  }
}

/**
 * Five swept machines - two on (one of them faulty), one off, one silent, one
 * refusing the saved password - plus a parked sixth with no fixture at all, so
 * a sweep that spoke to it would fail loudly rather than quietly counting it.
 */
function mixedRack(): Rack {
  return {
    tool: IPMITOOL_PRESENT,
    hosts: {
      '10.0.0.5': { power: POWER_ON, sdr: SDR_FAULTY },
      '10.0.0.6': { power: POWER_ON, sdr: SDR_HEALTHY },
      '10.0.0.7': { power: POWER_OFF, sdr: SDR_HEALTHY },
      '10.0.0.8': { power: NO_SESSION, sdr: NO_SESSION },
      '10.0.0.9': { power: BAD_PASSWORD, sdr: BAD_PASSWORD }
    }
  }
}

const MIXED_MACHINES: ReadonlyArray<Partial<BmcMachine>> = [{}, {}, {}, {}, {}, { enabled: false }]

function bmcHarness(rack: Rack, machines: ReadonlyArray<Partial<BmcMachine>>): ModuleHarness {
  const harness = moduleHarness('bmc', answerFor(rack), {
    config: sharedModuleConfig(doc(machines, { sensorEverySweeps: 1 }))
  })
  activateBmc(harness.ctx)
  return harness
}

function emitsOf(harness: ModuleHarness): ReadonlyArray<readonly [string, unknown]> {
  return harness.emit.mock.calls as unknown as ReadonlyArray<readonly [string, unknown]>
}

function pointsFrom(harness: ModuleHarness): SeriesPoint[] {
  return emitsOf(harness)
    .filter((call) => call[0] === SERIES_EVENT)
    .map((call) => call[1] as SeriesPoint)
}

function lastMachines(harness: ModuleHarness): MachinesPayload {
  const last = emitsOf(harness)
    .filter((call) => call[0] === 'machines')
    .at(-1)
  if (!last) throw new Error('the module never emitted a machines payload')
  return last[1] as MachinesPayload
}

interface OkResult {
  ok: boolean
  error?: string
}

/** A manual sweep, which is also the only way to run one deterministically. */
async function sweepNow(harness: ModuleHarness): Promise<OkResult> {
  const handler = harness.handlers.get('sweepNow')
  if (!handler) throw new Error('the module never registered a sweepNow handler')
  return (await handler()) as OkResult
}

describe('a whole sweep: the chart and the cards are the same reading', () => {
  it('adds exactly one point per sweep, whose counts are that sweep’s own card counts', async () => {
    const harness = bmcHarness(mixedRack(), MIXED_MACHINES)

    await sweepNow(harness)

    const points = pointsFrom(harness)
    expect(points).toHaveLength(1)

    // The invariant: a chart that disagrees with the cards under it
    // discredits both, and the two are published a line apart from one
    // payload precisely so they cannot.
    const payload = lastMachines(harness)
    expect(points[0]).toEqual({
      t: payload.t,
      on: payload.counts.on,
      off: payload.counts.off,
      unreachable: payload.counts.unreachable,
      watts: payload.counts.watts,
      authFailed: payload.counts.authFailed,
      sensorsWarn: payload.counts.sensorsWarn,
      sensorsBad: payload.counts.sensorsBad
    })

    // Stated outright as well, so the agreement above cannot be an agreement
    // between two sets of zeroes.
    expect(points[0]).toMatchObject({
      on: 2,
      off: 1,
      unreachable: 1,
      authFailed: 1,
      sensorsWarn: 2,
      sensorsBad: 1
    })
  })

  it('counts nothing for a parked machine, which the sweep never speaks to', async () => {
    const harness = bmcHarness(mixedRack(), MIXED_MACHINES)

    await sweepNow(harness)

    const commands = harness.exec.mock.calls.map((call) => call[0])
    expect(commands.some((command) => command.includes("-H '10.0.0.10'"))).toBe(false)
    // Six configured, five swept: the parked one is on no series at all.
    const point = pointsFrom(harness)[0]
    const swept = point.on + point.off + point.unreachable + point.authFailed
    expect(swept).toBe(5)
    expect(lastMachines(harness).counts.total).toBe(6)
  })

  it('adds a second point on the next sweep, showing what changed rather than repeating itself', async () => {
    const rack = mixedRack()
    const harness = bmcHarness(rack, MIXED_MACHINES)

    await sweepNow(harness)
    // The silent controller answers this time: the fleet gained a machine
    // that is on and lost one that was unreachable.
    rack.hosts['10.0.0.8'] = { power: POWER_ON, sdr: SDR_HEALTHY }
    await sweepNow(harness)

    const points = pointsFrom(harness)
    expect(points).toHaveLength(2)
    expect(points[0]).toMatchObject({ on: 2, unreachable: 1 })
    expect(points[1]).toMatchObject({ on: 3, unreachable: 0 })
    expect(points[1].t).toBeGreaterThanOrEqual(points[0].t)

    const payload = lastMachines(harness)
    expect(points[1]).toMatchObject({ t: payload.t, on: payload.counts.on })
  })

  it('writes no point at all when the management machine cannot run ipmitool', async () => {
    // A gap in the chart has to mean a gap in what was measured. A point of
    // zeroes here would read, hours later, as a rack that went dark.
    const harness = bmcHarness({ tool: IPMITOOL_MISSING, hosts: {} }, MIXED_MACHINES)

    const result = await sweepNow(harness)

    expect(result.ok).toBe(false)
    expect(pointsFrom(harness)).toEqual([])
    const commands = harness.exec.mock.calls.map((call) => call[0])
    expect(commands.some((command) => command.includes('chassis power status'))).toBe(false)
  })
})

/* ------------------------------------------------------------------------ */
/* The manifest and the chart specs that read what this file writes         */
/* ------------------------------------------------------------------------ */

const manifest = JSON.parse(
  readFileSync(join(process.cwd(), 'bmc', 'module.json'), 'utf8')
) as ModuleManifest

/** Every object anywhere in a spec, however it is nested. */
function everyObject(value: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  const pending: unknown[] = [value]
  const seen = new Set<object>()
  while (pending.length > 0) {
    const next = pending.pop()
    if (typeof next !== 'object' || next === null) continue
    if (seen.has(next)) continue
    seen.add(next)
    if (!Array.isArray(next)) out.push(next as Record<string, unknown>)
    for (const item of Array.isArray(next) ? next : Object.values(next)) pending.push(item)
  }
  return out
}

interface HistorySource {
  stream: string
  keys: string[]
  liveEvent: string
}

/** Every `{kind: 'history'}` chart source in a page or widget spec. */
function historySources(spec: unknown): HistorySource[] {
  const out: HistorySource[] = []
  for (const object of everyObject(spec)) {
    if (object['kind'] !== 'history') continue
    const stream = object['stream']
    const keys = object['keys']
    const liveEvent = object['liveEvent']
    if (typeof stream !== 'string' || !Array.isArray(keys) || typeof liveEvent !== 'string') continue
    out.push({ stream, keys: keys.filter((key): key is string => typeof key === 'string'), liveEvent })
  }
  return out
}

function pageSpecs(): Array<{ where: string; spec: unknown }> {
  return (manifest.pages ?? []).map((page) => ({
    where: `pages/${page.id}.json`,
    spec: JSON.parse(readFileSync(join(process.cwd(), 'bmc', 'ui', 'pages', `${page.id}.json`), 'utf8'))
  }))
}

describe('what the module writes and what its manifest and charts expect', () => {
  it('declares the history stream the log actually writes to', () => {
    // `addHistory(point)` with no stream name writes the module's own id. An
    // undeclared stream is refused by the host, so every point would be
    // dropped at the door and the archive would stay empty.
    expect(manifest.storage?.history?.streams).toContain(manifest.id)
    expect(manifest.id).toBe('bmc')
  })

  it('declares the event a point is emitted under, as a series stream rather than a latest one', () => {
    // `latest` keeps one value; a chart fed from it draws a single dot until
    // the history query behind it comes back.
    const declared = (manifest.streams ?? []).find((stream) => stream.event === SERIES_EVENT)

    expect(declared).toBeDefined()
    expect(declared?.kind).toBe('series')
  })

  it('plots only keys a point carries, from the stream a point is written to', () => {
    // The other half of the agreement: a chart naming `authFailures` where the
    // point says `authFailed` renders an empty axis with no error anywhere.
    const carried = new Set(Object.keys(pointFrom(distinctFleet(T0))))
    const declaredStreams = manifest.storage?.history?.streams ?? []
    const problems: string[] = []

    for (const { where, spec } of pageSpecs()) {
      for (const source of historySources(spec)) {
        if (!declaredStreams.includes(source.stream)) {
          problems.push(`${where} reads history stream ${source.stream}`)
        }
        if (source.liveEvent !== SERIES_EVENT) continue
        for (const key of source.keys) {
          if (!carried.has(key)) problems.push(`${where} plots ${key}`)
        }
      }
    }

    expect(problems).toEqual([])
    // And the charts that make this worth checking are actually there.
    expect(pageSpecs().flatMap(({ spec }) => historySources(spec)).length).toBeGreaterThan(0)
  })
})
