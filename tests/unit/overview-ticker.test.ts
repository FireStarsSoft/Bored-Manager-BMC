import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import {
  moduleHarness,
  sharedModuleConfig,
  type ModuleHarness,
  type ModuleHarnessOptions
} from '../helpers/module-harness'
import activateBmc from '../../bmc/main/index'
import { createRuntime } from '../../bmc/main/runtime'
import {
  buildMachinesPayload,
  buildOverview,
  type MachineRuntimeState,
  type MachinesPayload,
  type OverviewPayload
} from '../../bmc/main/sweep'
import { defaultSettings, type BmcConfig, type BmcMachine } from '../../bmc/main/store'

/**
 * What the Overview payload says.
 *
 * This file used to be about a blink. Until Bored Manager 0.6.0 a block spec
 * could not ask for movement, so the module made its own out of data: a second
 * poller re-published the meter about once a second and let the bar jump
 * between a red value and an amber one for as long as anything was critical.
 * 0.6.0 added an `attention` clause to `meter` and an `attentionKey` to
 * `statusCards` - a spec now says *when* something is urgent and the app
 * decides what urgent looks like - so the ticker, its poller, its phase and
 * its oscillation are all gone.
 *
 * What is left is one steady payload per sweep, and it has to carry two things
 * the renderer cannot work out for itself: a meter value that lands in the
 * right colour band, and a per-machine `attention` flag. Both are asserted
 * against the renderer's own thresholds rather than against this module's
 * constants, so retuning a number is free and landing one on the wrong side of
 * a band is not.
 */

/** src/components/charts/progress-bar.tsx: a meter paints red at 90 % of max. */
const RED_BAND = 90
/** ...amber at 70 %, and the ordinary tint below that. */
const AMBER_BAND = 70

const T = Date.UTC(2026, 7, 29, 9, 0, 0)

interface Spec {
  name: string
  enabled?: boolean
  /** Merged over "answered, powered on, no sensor read yet", which is `ok`. */
  state?: Partial<MachineRuntimeState>
}

function machineOf(index: number, spec: Spec): BmcMachine {
  return {
    id: `m${index}`,
    revision: 'r1',
    name: spec.name,
    ip: `10.0.0.${index + 1}`,
    port: 623,
    username: 'ADMIN',
    enabled: spec.enabled ?? true
  }
}

function fleet(specs: readonly Spec[], timestamp = T): MachinesPayload {
  const config: BmcConfig = {
    version: 3,
    settings: defaultSettings(),
    hintsOn: true,
    machines: specs.map((spec, index) => machineOf(index, spec))
  }
  const states = new Map<string, MachineRuntimeState>()
  specs.forEach((spec, index) => {
    if (!spec.state) return
    states.set(`m${index}`, {
      revision: 'r1',
      power: 'on',
      reach: 'ok',
      lastSeen: timestamp - 30_000,
      sensors: null,
      draw: null,
    clock: null,
      ...spec.state
    })
  })
  return buildMachinesPayload(config, states, timestamp)
}

/** Answering, powered on: the only combination that counts as healthy. */
const HEALTHY: Partial<MachineRuntimeState> = {}
/** A BMC that refused the saved credentials - worth looking at, not broken. */
const WARNING: Partial<MachineRuntimeState> = { reach: 'auth' }
/** A BMC that stopped answering at all. */
const CRITICAL: Partial<MachineRuntimeState> = { reach: 'timeout' }
/** Answering but powered down: neither a fault nor a clean bill. */
const POWERED_OFF: Partial<MachineRuntimeState> = { power: 'off' }

function healthyFleetOf(
  count: number,
  faults: ReadonlyArray<Partial<MachineRuntimeState>> = []
): MachinesPayload {
  const specs: Spec[] = Array.from({ length: count }, (_, index) => ({
    name: `srv-${String(index + 1).padStart(2, '0')}`,
    state: faults[index] ?? HEALTHY
  }))
  return fleet(specs)
}

/** `warned` of `count` machines refusing their credentials, and nothing critical. */
function warnedFleetOf(count: number, warned: number): MachinesPayload {
  return healthyFleetOf(
    count,
    Array.from({ length: warned }, () => WARNING)
  )
}

describe('buildOverview: the meter value the widget paints', () => {
  it('reports 0 for a fleet with nothing wrong, which is how the widget knows to hide the meter entirely', () => {
    // The widget wraps the meter in a `conditional` on healthLevel > 0, so a
    // healthy fleet draws no bar at all - and the value behind it says the
    // same thing rather than a small one that would read as a faint warning.
    const overview = buildOverview(
      fleet([
        { name: 'a', state: HEALTHY },
        { name: 'b', state: POWERED_OFF }
      ])
    )

    expect(overview.healthLevel).toBe(0)
    expect(overview.meterValue).toBe(0)
  })

  it('draws every warning inside the amber band and none of them in the red one', () => {
    // The band relationship is the assertion. A warning must never be drawn in
    // the ordinary tint - that is a bar saying nothing is wrong - and never in
    // red, which is a bar saying something is broken.
    for (const warned of [1, 5, 10, 15, 19, 20]) {
      const overview = buildOverview(warnedFleetOf(20, warned))

      expect(overview.healthLevel).toBe(1)
      expect(overview.meterValue).toBeGreaterThanOrEqual(AMBER_BAND)
      expect(overview.meterValue).toBeLessThan(RED_BAND)
    }
  })

  it('scales a warning with the share of the fleet it covers - one of twenty is a different morning from nineteen', () => {
    // Shares chosen inside the band on purpose, so this measures the scaling
    // rather than the clamps the next two cases are about.
    const values = [15, 16, 17].map((warned) => buildOverview(warnedFleetOf(20, warned)).meterValue)

    expect(values[0]).toBeLessThan(values[1])
    expect(values[1]).toBeLessThan(values[2])
    expect(values.every((value) => value > AMBER_BAND && value < RED_BAND)).toBe(true)
  })

  it('floors a lone warning at the amber threshold, because one warned machine out of thirty is still a warning', () => {
    // 1 of 30 is 3.3 %, which would draw as a sliver of a bar in the ordinary
    // tint. The floor is the amber threshold itself, so the colour reports the
    // severity and only the length reports how much of the fleet it covers.
    const lone = buildOverview(warnedFleetOf(30, 1))
    const two = buildOverview(warnedFleetOf(30, 2))

    expect(lone.meterValue).toBe(AMBER_BAND)
    // Still clamped, so a second warned machine cannot drag the bar below the
    // band it belongs in.
    expect(two.meterValue).toBe(AMBER_BAND)
  })

  it('caps a fleet-wide warning just under the red band, so amber can never masquerade as critical', () => {
    // 19 of 20 is 95 % and 20 of 20 is 100 %; both would land inside the
    // renderer's red band and make a warning indistinguishable from a machine
    // that is down.
    const nearly = buildOverview(warnedFleetOf(20, 19))
    const all = buildOverview(warnedFleetOf(20, 20))

    expect(nearly.healthLevel).toBe(1)
    expect(all.healthLevel).toBe(1)
    expect(nearly.meterValue).toBe(RED_BAND - 1)
    expect(all.meterValue).toBe(nearly.meterValue)
  })

  it('sends anything critical into the red band, and does not scale it by how many are broken', () => {
    const one = buildOverview(healthyFleetOf(20, [CRITICAL]))
    const ten = buildOverview(
      healthyFleetOf(
        20,
        Array.from({ length: 10 }, () => CRITICAL)
      )
    )

    expect(one.healthLevel).toBe(2)
    expect(one.meterValue).toBeGreaterThanOrEqual(RED_BAND)
    expect(one.meterValue).toBeLessThanOrEqual(100)
    // "How many are broken" does not change what has to happen next.
    expect(ten.meterValue).toBe(one.meterValue)
  })

  it('keeps every critical meter above every warning one, whatever the shares are', () => {
    // The one comparison that has to hold across the whole range: the worst
    // warning the module can draw is still quieter than the mildest fault.
    const loudestWarning = buildOverview(warnedFleetOf(20, 19)).meterValue
    const quietestCritical = buildOverview(healthyFleetOf(20, [CRITICAL])).meterValue

    expect(quietestCritical).toBeGreaterThan(loudestWarning)
  })
})

describe('buildOverview: which cards ask for attention', () => {
  /** One machine of every status the wall can show, in one payload. */
  const MIXED = fleet([
    { name: 'broken', state: CRITICAL },
    { name: 'warned', state: WARNING },
    { name: 'parked-off', state: POWERED_OFF },
    { name: 'never-checked' },
    { name: 'fine', state: HEALTHY }
  ])

  it('marks exactly the critical cards, which is what the widget reads through attentionKey', () => {
    const overview = buildOverview(MIXED)
    const byStatus = new Map(overview.machines.map((card) => [card.status, card.attention]))

    expect(byStatus.get('bad')).toBe(true)
    expect(byStatus.get('warn')).toBe(false)
    expect(byStatus.get('unknown')).toBe(false)
    expect(byStatus.get('ok')).toBe(false)
  })

  it('never marks an amber card, because a wall where every warning moves says nothing about which one to open', () => {
    const overview = buildOverview(warnedFleetOf(6, 4))

    expect(overview.healthLevel).toBe(1)
    expect(overview.machines.filter((card) => card.status === 'warn')).toHaveLength(4)
    expect(overview.machines.some((card) => card.attention)).toBe(false)
  })

  it('never marks a card the module simply has not heard from, which is a gap rather than a fault', () => {
    const overview = buildOverview(
      fleet([{ name: 'quiet' }, { name: 'off', state: POWERED_OFF }])
    )

    expect(overview.machines.map((card) => card.status)).toEqual(['unknown', 'unknown'])
    expect(overview.machines.every((card) => card.attention === false)).toBe(true)
  })

  it('keeps the flag in step with the status on every card of a mixed fleet', () => {
    // Stated as an equivalence rather than as a list, so a fifth status - or a
    // fold that starts calling something else `bad` - is covered by the same
    // case.
    const overview = buildOverview(MIXED)

    for (const card of overview.machines) {
      expect(card.attention).toBe(card.status === 'bad')
    }
  })
})

describe('buildOverview: the wall of cards', () => {
  const specs: Spec[] = Array.from({ length: 16 }, (_, index) => ({
    name: `srv-${String(index + 1).padStart(2, '0')}`,
    state: HEALTHY
  }))
  specs[8] = { name: 'srv-09', state: CRITICAL }
  specs[2] = { name: 'srv-03', state: WARNING }
  specs[13] = { name: 'srv-14', state: WARNING }
  specs[10] = { name: 'srv-11', state: POWERED_OFF }
  // Named to sort first and last, so their absence is the filter and not luck.
  const withParked: Spec[] = [
    ...specs,
    { name: 'aaa-parked', enabled: false, state: HEALTHY },
    { name: 'zzz-parked', enabled: false, state: HEALTHY }
  ]

  it('sorts worst-first and then by name, so the card that needs a person is never below the fold', () => {
    const overview = buildOverview(fleet(withParked))

    expect(overview.machines.slice(0, 4).map((card) => [card.name, card.status])).toEqual([
      ['srv-09', 'bad'],
      ['srv-03', 'warn'],
      ['srv-14', 'warn'],
      ['srv-11', 'unknown']
    ])
    expect(overview.machines.slice(4).every((card) => card.status === 'ok')).toBe(true)
    // The one card asking for attention is also the first one on the wall.
    expect(overview.machines.findIndex((card) => card.attention)).toBe(0)
  })

  it('caps the wall and reports exactly how many it left out', () => {
    const overview = buildOverview(fleet(withParked))

    expect(overview.machines).toHaveLength(12)
    // 16 enabled machines, 12 shown: the two parked ones are in neither figure.
    expect(overview.hidden).toBe(4)
    expect(overview.machines.length + overview.hidden).toBe(16)
  })

  it('reports nothing hidden when the whole fleet fits', () => {
    const overview = buildOverview(healthyFleetOf(12))

    expect(overview.machines).toHaveLength(12)
    expect(overview.hidden).toBe(0)
  })

  it('only ever drops healthy machines, because a cap that could hide a fault is worse than no cap', () => {
    const payload = fleet(withParked)
    const overview = buildOverview(payload)
    const shown = new Set(overview.machines.map((card) => card.name))

    const dropped = payload.machines.filter((card) => card.enabled && !shown.has(card.name))
    expect(dropped.map((card) => card.name)).toEqual(['srv-12', 'srv-13', 'srv-15', 'srv-16'])
    expect(dropped.every((card) => card.status === 'ok')).toBe(true)
    const faulty = payload.machines.filter((card) => card.enabled && card.status !== 'ok')
    expect(faulty.every((card) => shown.has(card.name))).toBe(true)
  })

  it('leaves parked machines off the wall entirely - they are not being asked anything, so they report nothing', () => {
    const overview = buildOverview(fleet(withParked))

    expect(overview.machines.map((card) => card.name)).not.toContain('aaa-parked')
    expect(overview.machines.map((card) => card.name)).not.toContain('zzz-parked')
    expect(overview.counts.disabled).toBe(2)
  })

  it('carries each card down to its chips as {label, status, pinned}, pinned on everything that is not ok', () => {
    const overview = buildOverview(
      fleet([
        { name: 'alpha', state: HEALTHY },
        { name: 'bravo', state: WARNING }
      ])
    )

    expect(overview.machines[0].name).toBe('bravo')
    expect(overview.machines[0].chips).toEqual([{ label: 'Auth failed', status: 'warn', pinned: true }])
    expect(overview.machines[1].chips).toEqual([{ label: 'Power on', status: 'ok', pinned: false }])
    expect(overview.machines[0].summary).toBe('Auth failed')
  })
})

describe('buildOverview: the line under the title', () => {
  it('says nothing has been saved rather than drawing an empty rack', () => {
    expect(buildOverview(fleet([])).label).toBe('No machines saved yet')
  })

  it('distinguishes an empty list from a list nobody is sweeping', () => {
    const overview = buildOverview(
      fleet([
        { name: 'a', enabled: false, state: HEALTHY },
        { name: 'b', enabled: false, state: HEALTHY }
      ])
    )

    expect(overview.label).toBe('Every machine is parked')
    expect(overview.meterValue).toBe(0)
  })

  it('reads as a sentence for a single machine instead of "All 1 machines healthy"', () => {
    expect(buildOverview(fleet([{ name: 'only', state: HEALTHY }])).label).toBe(
      'The one machine is healthy'
    )
  })

  it('counts the fleet when everything is fine', () => {
    expect(buildOverview(healthyFleetOf(7)).label).toBe('All 7 machines healthy')
  })

  it('counts warnings and criticals together, because both are things a person has to look at', () => {
    const overview = buildOverview(healthyFleetOf(9, [CRITICAL, WARNING, WARNING]))

    expect(overview.label).toBe('3 of 9 need attention')
  })
})

/* ------------------------------------------------------------------------ */
/* The publisher, and the poller list it no longer adds to.                  */
/* ------------------------------------------------------------------------ */

/**
 * `createRuntime` rather than the publisher alone, because the poller list is
 * half of what is under test: the sweep is now the only poller this module
 * registers, and the Overview rides on it.
 */
function publisherHarness(options: ModuleHarnessOptions = {}) {
  const harness = moduleHarness(
    'bmc',
    () => ({ stdout: 'ipmitool version 1.8.18\n', stderr: '', code: 0 }),
    options
  )
  const runtime = createRuntime(harness.ctx)
  return { harness, runtime }
}

function overviewEmits(harness: ModuleHarness): OverviewPayload[] {
  const calls = harness.emit.mock.calls as Array<[string, OverviewPayload]>
  return calls.filter(([event]) => event === 'overview').map(([, payload]) => payload)
}

const CRITICAL_FLEET = fleet([
  { name: 'rack-a', state: CRITICAL },
  { name: 'rack-b', state: HEALTHY }
])
const CALM_FLEET = fleet([
  { name: 'rack-a', state: HEALTHY },
  { name: 'rack-b', state: HEALTHY }
])
const WARNING_FLEET = fleet([
  { name: 'rack-a', state: WARNING },
  { name: 'rack-b', state: HEALTHY }
])

describe('OverviewPublisher: who owns the overview stream', () => {
  it('registers no poller of its own - the sweep is the only one this module runs', () => {
    const { harness, runtime } = publisherHarness()

    expect(harness.pollers).toHaveLength(1)
    expect(harness.ticks).toHaveLength(1)
    expect(runtime.sweeper.poller).toBe(harness.pollers[0])
    // Nothing on the publisher to start or stop: the movement belongs to the
    // renderer now, and a second timer would be a wakeup a second for a card
    // whose value never changes between sweeps.
    expect('poller' in runtime.overview).toBe(false)
  })

  it('emits the overview exactly once per publish, so one sweep never paints the card twice', () => {
    const { harness, runtime } = publisherHarness()

    runtime.overview.publish(CRITICAL_FLEET)

    expect(overviewEmits(harness)).toHaveLength(1)
    expect(runtime.overview.latest).toEqual(overviewEmits(harness)[0])
  })

  it('emits one frame per publish and no more, however bad the fleet is', () => {
    const { harness, runtime } = publisherHarness()

    runtime.overview.publish(CRITICAL_FLEET)
    runtime.overview.publish(CALM_FLEET)
    runtime.overview.publish(CRITICAL_FLEET)

    expect(overviewEmits(harness)).toHaveLength(3)
    expect(overviewEmits(harness).map((payload) => payload.healthLevel)).toEqual([2, 0, 2])
  })

  it('hands back what it published, so the sweeper and the snapshot agree', () => {
    const { runtime } = publisherHarness()

    const returned = runtime.overview.publish(CRITICAL_FLEET)

    expect(returned).toEqual(buildOverview(CRITICAL_FLEET))
    expect(runtime.overview.latest).toBe(returned)
  })
})

describe('OverviewPublisher: when the module stops', () => {
  it('publishes nothing after dispose and touches nothing on a revoked context', () => {
    const { harness, runtime } = publisherHarness()
    runtime.overview.publish(CRITICAL_FLEET)
    const settled = overviewEmits(harness).length

    runtime.overview.dispose()
    // The host revokes the context when a module stops; a sweep still
    // unwinding must not reach through it (docs/MODULE-RULESET.md).
    harness.revoke()
    runtime.overview.publish(CRITICAL_FLEET)

    expect(overviewEmits(harness)).toHaveLength(settled)
    expect(harness.afterStopCalls).toEqual([])
  })

  it('forgets the last payload on reset, so a re-activated module does not report a fleet nobody has swept yet', () => {
    const { runtime } = publisherHarness()
    runtime.overview.publish(CRITICAL_FLEET)

    runtime.overview.reset()

    expect(runtime.overview.latest).toBeNull()
  })

  it('answers a browser that opens before the first sweep with a built payload rather than nothing', () => {
    const { runtime } = publisherHarness()

    const snapshot = runtime.snapshots().overview as OverviewPayload

    expect(runtime.overview.latest).toBeNull()
    expect(snapshot.label).toBe('No machines saved yet')
    expect(snapshot.meterValue).toBe(0)
  })
})

/* ------------------------------------------------------------------------ */
/* One sweep, one frame - through the module the way the host drives it.     */
/* ------------------------------------------------------------------------ */

const IPMITOOL_VERSION = 'ipmitool version 1.8.18\n'
const NO_SESSION = 'Error: Unable to establish IPMI v2 / RMCP+ session\n'

function unreachableFleet(command: string): ModuleExecResult {
  if (command.includes('command -v ipmitool')) {
    return { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
  }
  return { stdout: '', stderr: NO_SESSION, code: 1 }
}

function fleetDocument(count: number): BmcConfig {
  return {
    version: 3,
    machines: Array.from({ length: count }, (_, index) => ({
      id: `m${index + 1}`,
      revision: `r${index + 1}`,
      name: `Server ${index + 1}`,
      ip: `10.0.0.${index + 1}`,
      port: 623,
      username: 'admin',
      enabled: true
    })),
    settings: { ...defaultSettings(), sensorEverySweeps: 0 },
    hintsOn: true
  }
}

/** The passwords the sweep will fetch, one per machine, as the store holds them. */
function secretsFor(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`machine/m${index + 1}`, 'secret'])
  )
}

async function sweepNow(harness: ModuleHarness): Promise<void> {
  const handler = harness.handlers.get('sweepNow')
  if (!handler) throw new Error('the module never registered a sweepNow handler')
  await handler()
}

describe('the overview stream over a real sweep', () => {
  it('publishes exactly one overview frame per sweep, and registers only the sweep poller to do it', async () => {
    const harness = moduleHarness('bmc', unreachableFleet, {
      config: sharedModuleConfig(fleetDocument(2)),
      secrets: secretsFor(2)
    })
    activateBmc(harness.ctx)

    await sweepNow(harness)
    expect(overviewEmits(harness)).toHaveLength(1)

    await sweepNow(harness)
    expect(overviewEmits(harness)).toHaveLength(2)

    // The old design published the fleet once and then re-published it about
    // once a second from a second poller for as long as anything was wrong.
    // Two sweeps are now two frames, and there is nothing else running.
    expect(harness.pollers).toHaveLength(1)
  })

  it('sends a critical fleet out with the meter in the red band and the broken cards flagged', async () => {
    const harness = moduleHarness('bmc', unreachableFleet, {
      config: sharedModuleConfig(fleetDocument(2)),
      secrets: secretsFor(2)
    })
    activateBmc(harness.ctx)

    await sweepNow(harness)

    const [payload] = overviewEmits(harness)
    expect(payload.healthLevel).toBe(2)
    expect(payload.meterValue).toBeGreaterThanOrEqual(RED_BAND)
    expect(payload.machines.map((card) => card.attention)).toEqual([true, true])
  })

  it('goes quiet on the meter and flags nothing once the fleet answers again', async () => {
    let reachable = false
    const harness = moduleHarness(
      'bmc',
      (command) => {
        if (command.includes('command -v ipmitool')) {
          return { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
        }
        return reachable
          ? { stdout: 'Chassis Power is on\n', stderr: '', code: 0 }
          : { stdout: '', stderr: NO_SESSION, code: 1 }
      },
      { config: sharedModuleConfig(fleetDocument(2)), secrets: secretsFor(2) }
    )
    activateBmc(harness.ctx)

    await sweepNow(harness)
    reachable = true
    await sweepNow(harness)

    const latest = overviewEmits(harness).at(-1)
    expect(latest?.healthLevel).toBe(0)
    expect(latest?.meterValue).toBe(0)
    expect(latest?.machines.some((card) => card.attention)).toBe(false)
  })
})

/* ------------------------------------------------------------------------ */
/* Notices                                                                   */
/* ------------------------------------------------------------------------ */

describe('OverviewPublisher: interrupting somebody who is looking elsewhere', () => {
    it('says nothing on the first sweep, however bad the fleet is', () => {
        // Nothing to compare against yet. A fault that has been there all week
        // announced as news the moment somebody opens the app is a false alarm,
        // and "still fine" to somebody who just connected is noise.
        const { harness, runtime } = publisherHarness()

        runtime.overview.publish(CRITICAL_FLEET)

        expect(harness.notices).toEqual([])
    })

    it('speaks once when the fleet crosses into critical, and not again while it stays there', () => {
        const { harness, runtime } = publisherHarness()
        runtime.overview.publish(CALM_FLEET)

        runtime.overview.publish(CRITICAL_FLEET)
        expect(harness.notices).toHaveLength(1)
        expect(harness.notices[0].level).toBe('error')
        expect(harness.notices[0].key).toBe('fleet-critical')
        expect(harness.notices[0].title).toMatch(/critical/i)

        // A sweep a minute, a fault that lasts hours: announcing the state
        // rather than the change would be an interruption an hour, forever.
        runtime.overview.publish(CRITICAL_FLEET)
        runtime.overview.publish(CRITICAL_FLEET)
        expect(harness.notices).toHaveLength(1)
    })

    it('says so when the fleet comes back, so a cleared alarm does not stay open in somebody’s head', () => {
        const { harness, runtime } = publisherHarness()
        runtime.overview.publish(CALM_FLEET)
        runtime.overview.publish(CRITICAL_FLEET)

        runtime.overview.publish(CALM_FLEET)

        expect(harness.notices).toHaveLength(2)
        // A different key from the alarm: sharing one would have the app's
        // own per-key dedupe swallow a recovery inside the same minute.
        expect(harness.notices[1].key).not.toBe(harness.notices[0].key)
        expect(harness.notices[1].level).toBe('info')
        expect(harness.notices[1].title).toMatch(/not critical|no longer|any more/i)
    })

    it('does not interrupt anybody over a warning', () => {
        // Amber is what the Overview card is for. Only something broken earns
        // the right to reach a person who is looking at something else.
        const { harness, runtime } = publisherHarness()
        runtime.overview.publish(CALM_FLEET)

        runtime.overview.publish(WARNING_FLEET)

        expect(harness.notices).toEqual([])
    })

    it('starts the comparison over after a reset, because the next sweep is a first look', () => {
        const { harness, runtime } = publisherHarness()
        runtime.overview.publish(CALM_FLEET)
        runtime.overview.publish(CRITICAL_FLEET)
        expect(harness.notices).toHaveLength(1)

        runtime.overview.reset()
        runtime.overview.publish(CRITICAL_FLEET)

        expect(harness.notices).toHaveLength(1)
    })

    it('says nothing once the module has stopped', () => {
        const { harness, runtime } = publisherHarness()
        runtime.overview.publish(CALM_FLEET)

        runtime.overview.dispose()
        runtime.overview.publish(CRITICAL_FLEET)

        expect(harness.notices).toEqual([])
    })
})
