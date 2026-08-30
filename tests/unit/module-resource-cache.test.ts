import { describe, expect, it, vi } from 'vitest'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import activateBmc from '../../bmc/main/index'
import { defaultSettings, type BmcConfig, type BmcMachine } from '../../bmc/main/store'

/**
 * What one open page costs. Every other module in this family pays for a poll
 * on the machine Bored Manager is already connected to; this one pays on the
 * network, against BMC endpoints the user typed in. An `ipmitool` invocation is
 * a UDP session to a controller with a slow, single-threaded processor in it,
 * and the module runs `-N 3 -R 2` behind each one - so an extra command per
 * machine per sweep is not a wasted process, it is load on hardware the user
 * did not agree to have hammered.
 *
 * These cases pin the budget: one command per enabled machine, a second only
 * when sensors are actually due, concurrent callers joined into one pass, and
 * nothing at all from an instance that is not the elected primary.
 *
 * Split out of the app repository's tests/unit/shared/module-resource-cache.test.ts,
 * which covered several modules in one file, when this module moved to its own
 * repository.
 */

const IPMITOOL_VERSION = 'ipmitool version 1.8.18\n'
const POWER_ON = 'Chassis Power is on\n'
/** The pipe-separated shape `ipmitool sdr elist` prints. */
const SDR_ELIST = [
  'Inlet Temp       | 04h | ok  |  7.1 | 22 degrees C',
  'FAN1             | 30h | ok  | 29.1 | 5100 RPM',
  'PSU1 Status      | 70h | ok  | 10.1 | Presence detected',
  ''
].join('\n')
/** What a BMC that is not answering on UDP 623 looks like from ipmitool. */
const NO_SESSION = 'Error: Unable to establish IPMI v2 / RMCP+ session\n'

function isProbe(command: string): boolean {
  return command.includes('command -v ipmitool')
}

function healthyFleetAnswer(command: string): { stdout: string; stderr: string; code: number } {
  if (isProbe(command)) return { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
  if (command.includes('sdr elist')) return { stdout: SDR_ELIST, stderr: '', code: 0 }
  if (command.includes('chassis power status')) return { stdout: POWER_ON, stderr: '', code: 0 }
  return { stdout: '', stderr: '', code: 0 }
}

function unreachableFleetAnswer(command: string): { stdout: string; stderr: string; code: number } {
  if (isProbe(command)) return { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
  return { stdout: '', stderr: NO_SESSION, code: 1 }
}

function machine(n: number, enabled: boolean): BmcMachine {
  return {
    id: `m${n}`,
    revision: `r${n}`,
    name: `Server ${n}`,
    ip: `10.0.0.${n}`,
    port: 623,
    username: 'admin',
    enabled
  }
}

/** `parked` counts from the end, so machine 1 is always the enabled one. */
function fleet(count: number, sensorEverySweeps: number, parked = 0): BmcConfig {
  return {
    // Version 3: the passwords are in the app's secret store, not in here.
    version: 3,
    machines: Array.from({ length: count }, (_, index) =>
      machine(index + 1, index < count - parked)
    ),
    settings: { ...defaultSettings(), sensorEverySweeps },
    hintsOn: true
  }
}

/**
 * The credentials the sweep will fetch, one per machine.
 *
 * Seeded rather than left empty on purpose: a machine with no usable password
 * is settled before anything reaches the network, so an unseeded fleet would
 * make every budget below read as zero and prove nothing.
 */
function secretsFor(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`machine/m${index + 1}`, 'secret'])
  )
}

function commands(harness: ModuleHarness): string[] {
  return harness.exec.mock.calls.map(([command]) => command)
}

function countMatching(harness: ModuleHarness, needle: string): number {
  return commands(harness).filter((command) => command.includes(needle)).length
}

/**
 * Activate and get past the one-off `ipmitool -V` probe, then forget it: every
 * budget below is the cost of a sweep, not of starting the module.
 */
async function swept(harness: ModuleHarness): Promise<void> {
  const lifecycle = activateBmc(harness.ctx)
  lifecycle.applyPollers?.()
  await vi.waitFor(() => expect(harness.pollers[0]?.start).toHaveBeenCalledWith(60_000))
  harness.exec.mockClear()
}

describe('what one sweep of the fleet costs', () => {
  it('spends a power, sensor, draw and clock read per machine on the first sensor sweep', async () => {
    const harness = moduleHarness('bmc', healthyFleetAnswer, {
      config: sharedModuleConfig(fleet(3, 1)),
      secrets: secretsFor(3)
    })
    await swept(harness)

    await harness.ticks[0]()

    // Fetching a password costs nothing here - it is a map lookup and a
    // decrypt inside the app, not a command on the connected machine. Three of
    // the four only happen on a sensor sweep, and two of those stop happening
    // again: the cases below are what keep this from becoming the steady rate.
    expect(harness.exec).toHaveBeenCalledTimes(12)
    expect(countMatching(harness, 'chassis power status')).toBe(3)
    expect(countMatching(harness, 'sdr elist')).toBe(3)
    expect(countMatching(harness, 'dcmi power reading')).toBe(3)
    expect(countMatching(harness, 'sel time get')).toBe(3)
  })

  it('asks about a controller clock once an hour, not once a sweep', async () => {
    // Drift moves by one second per second, so an hour-old reading is as good
    // as a fresh one for deciding whether an event log lines up with anything.
    // On the sensor cadence this was a fourth command per machine per sensor
    // sweep for a number that had not meaningfully moved.
    const harness = moduleHarness('bmc', healthyFleetAnswer, {
      config: sharedModuleConfig(fleet(3, 1)),
      secrets: secretsFor(3)
    })
    await swept(harness)

    await harness.ticks[0]()
    expect(countMatching(harness, 'sel time get')).toBe(3)

    await harness.ticks[0]()
    await harness.ticks[0]()

    expect(countMatching(harness, 'sel time get')).toBe(3)
    // While the readings that do move carry on every sensor sweep.
    expect(countMatching(harness, 'sdr elist')).toBe(9)
  })

  it('never asks a controller for its thresholds during a sweep', async () => {
    // `sensor list` is a drawer cost: it answers the thresholds behind one
    // machine's readings, for the one table that shows them. On a sweep it
    // would be a command per machine per cycle for a number nothing on the
    // fleet view displays.
    const harness = moduleHarness('bmc', healthyFleetAnswer, {
      config: sharedModuleConfig(fleet(3, 1)),
      secrets: secretsFor(3)
    })
    await swept(harness)

    await harness.ticks[0]()

    expect(countMatching(harness, 'sensor list')).toBe(0)
  })

  it('stops asking a controller for a power draw once it has refused', async () => {
    // DCMI is optional and plenty of boards do not implement it. Asking one
    // that has already said so, once per machine per sensor sweep, for the
    // life of the install, is a command spent re-learning something known.
    const harness = moduleHarness(
      'bmc',
      (command) => {
        if (command.includes('dcmi power reading')) {
          return { stdout: '', stderr: 'Error: Unsupported command', code: 1 }
        }
        return healthyFleetAnswer(command)
      },
      { config: sharedModuleConfig(fleet(3, 1)), secrets: secretsFor(3) }
    )
    await swept(harness)

    await harness.ticks[0]()
    expect(countMatching(harness, 'dcmi power reading')).toBe(3)

    await harness.ticks[0]()
    await harness.ticks[0]()

    // Three refusals, once each, and never again - while the power and sensor
    // reads carry on every sweep as normal.
    expect(countMatching(harness, 'dcmi power reading')).toBe(3)
    expect(countMatching(harness, 'chassis power status')).toBe(9)
  })

  it('spends only the power read per machine when sensor folding is turned off', async () => {
    const harness = moduleHarness('bmc', healthyFleetAnswer, {
      config: sharedModuleConfig(fleet(3, 0)),
      secrets: secretsFor(3)
    })
    await swept(harness)

    await harness.ticks[0]()

    // `sensorEverySweeps: 0` is the setting that returns the module to
    // power-only health; it has to actually cost less, not just report less.
    expect(harness.exec).toHaveBeenCalledTimes(3)
    expect(countMatching(harness, 'chassis power status')).toBe(3)
    expect(countMatching(harness, 'sdr elist')).toBe(0)
    expect(countMatching(harness, 'sel time get')).toBe(0)
  })

  it('gives a parked machine a card without giving it a command', async () => {
    const harness = moduleHarness('bmc', healthyFleetAnswer, {
      config: sharedModuleConfig(fleet(3, 1, 2)),
      secrets: secretsFor(3)
    })
    await swept(harness)

    await harness.ticks[0]()

    // One enabled machine out of three: the fleet costs what a fleet of one
    // costs, and the two parked endpoints are never addressed.
    expect(harness.exec).toHaveBeenCalledTimes(4)
    expect(commands(harness).every((command) => command.includes("-H '10.0.0.1'"))).toBe(true)
    // Parking is not deleting, so all three still reach the page.
    expect(harness.emit).toHaveBeenCalledWith(
      'machines',
      expect.objectContaining({
        counts: expect.objectContaining({ total: 3, monitored: 1, disabled: 2 })
      })
    )
  })
})

describe('module read coalescing', () => {
  /** Run `presses` "Sweep now" calls at the same instant and report what went out. */
  async function pressSweepNow(presses: number): Promise<{ probes: number; ipmi: number }> {
    const harness = moduleHarness('bmc', healthyFleetAnswer, {
      config: sharedModuleConfig(fleet(3, 1)),
      secrets: secretsFor(3)
    })
    await swept(harness)
    const sweepNow = harness.handlers.get('sweepNow')
    expect(sweepNow).toBeDefined()

    const results = await Promise.all(
      Array.from({ length: presses }, () => Promise.resolve(sweepNow!()))
    )
    expect(results).toEqual(Array.from({ length: presses }, () => ({ ok: true })))

    return {
      probes: commands(harness).filter(isProbe).length,
      ipmi: countMatching(harness, '-I lanplus')
    }
  }

  it('joins two simultaneous "Sweep now" presses into one pass over the fleet', async () => {
    const onePress = await pressSweepNow(1)
    const twoPresses = await pressSweepNow(2)

    // Two people on two browsers, or a double-click: the second caller waits
    // on the run already in flight rather than opening a second session to
    // every controller in the rack.
    expect(twoPresses).toEqual(onePress)
    expect(twoPresses).toEqual({ probes: 1, ipmi: 12 })
  })
})

describe('primary election for the automatic sweep', () => {
  it('leaves a second connected machine idle so both do not hammer the same endpoints', async () => {
    // One settings document, two connected machines' instances of the module -
    // which is what makes the endpoints in it a shared resource rather than
    // this instance's own.
    const config = sharedModuleConfig(fleet(2, 1))
    const secrets = secretsFor(2)
    const primary = moduleHarness('bmc', healthyFleetAnswer, {
      config,
      secrets,
      isPrimaryInstance: true
    })
    const secondary = moduleHarness('bmc', healthyFleetAnswer, {
      config,
      secrets,
      isPrimaryInstance: false
    })

    activateBmc(primary.ctx).applyPollers?.()
    activateBmc(secondary.ctx).applyPollers?.()
    await vi.waitFor(() => expect(primary.pollers[0]?.start).toHaveBeenCalledWith(60_000))

    // Not even the `ipmitool -V` probe: an instance that will never sweep has
    // nothing to find out.
    expect(secondary.exec).not.toHaveBeenCalled()
    expect(secondary.pollers).toHaveLength(1)
    expect(secondary.pollers[0].start).not.toHaveBeenCalled()
    // And it parks the sweep poller rather than leaving one running from when
    // it was the primary.
    expect(secondary.pollers[0].stop).toHaveBeenCalled()
  })
})

/**
 * The Overview used to cost a second poller.
 *
 * Before 0.6.0 the only way for a module to ask for movement was to make it
 * out of data, so a critical fleet ran a `bmc:overview` ticker that woke up
 * about once a second and re-published the same payload with a different meter
 * value - for as long as anything was wrong, which on a bad day is all day.
 * 0.6.0 moved that to the renderer through the spec's `attention` clause, and
 * the timer went with it. What is pinned here is the cost: one poller, and one
 * overview frame per sweep.
 */
describe('what the Overview card costs', () => {
  it('registers exactly one poller - the sweep - and nothing that runs between sweeps', async () => {
    const harness = moduleHarness('bmc', unreachableFleetAnswer, {
      config: sharedModuleConfig(fleet(2, 1)),
      secrets: secretsFor(2),
      activeStreams: ['machines', 'overview']
    })
    await swept(harness)

    await harness.ticks[0]()

    expect(harness.pollers).toHaveLength(1)
    expect(harness.ticks).toHaveLength(1)
    expect(harness.pollers[0].start).toHaveBeenCalledWith(60_000)
    // A critical fleet with somebody watching it: the case that used to start
    // the second timer, and the one that has to stay at one poller.
    expect(harness.emit).toHaveBeenCalledWith(
      'overview',
      expect.objectContaining({ healthLevel: 2 })
    )
  })

  it('publishes one overview frame per sweep, whatever the fleet looks like and whoever is watching', async () => {
    const harness = moduleHarness('bmc', unreachableFleetAnswer, {
      config: sharedModuleConfig(fleet(2, 1)),
      secrets: secretsFor(2),
      activeStreams: ['machines']
    })
    await swept(harness)

    await harness.ticks[0]()
    const afterOne = harness.emit.mock.calls.filter(([event]) => event === 'overview').length
    await harness.ticks[0]()
    const afterTwo = harness.emit.mock.calls.filter(([event]) => event === 'overview').length

    expect(afterOne).toBe(1)
    expect(afterTwo).toBe(2)
  })

  it('costs the fleet nothing extra: the overview is built from the sweep that already ran', async () => {
    const harness = moduleHarness('bmc', healthyFleetAnswer, {
      config: sharedModuleConfig(fleet(3, 1)),
      secrets: secretsFor(3),
      activeStreams: ['machines', 'overview']
    })
    await swept(harness)

    await harness.ticks[0]()

    // The same twelve invocations as a sweep with no Overview open at all -
    // the card is a second reading of one pass, not a second pass.
    expect(harness.exec).toHaveBeenCalledTimes(12)
    expect(harness.emit).toHaveBeenCalledWith('overview', expect.objectContaining({ healthLevel: 0 }))
  })
})
