import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import activateBmc from '../../bmc/main/index'
import { defaultSettings, type BmcConfig, type BmcMachine } from '../../bmc/main/store'

/**
 * A module's fire-and-forget work - a fleet job, a manual slow refresh - can
 * still be waiting on the target when the user disables the module, reloads
 * it, or the machine disconnects. The host revokes the context at that point,
 * and until this was guarded the late `emit`/`log`/host-data write threw from
 * a promise nobody was holding, which the server treated as fatal: one browser
 * tab disabling a module took every machine, terminal and user down with it.
 *
 * This module is the worst case for it. A sweep is a network round trip to a
 * BMC that answers slowly, with `-N 3 -R 2` of retries behind it, so the
 * window between "the user switched the module off" and "the controller
 * finally replied" is measured in seconds rather than microtasks.
 *
 * The scaffolding below is copied rather than shared: this started as one
 * suite in the app repository covering several modules at once, and each
 * module that moved to its own repository took its own cases with it. Copying
 * ~40 lines is what lets the *reason* travel with the test.
 */

/** Any rejection or throw that escapes to the process is what we are testing for. */
function trapProcessFailures(): { failures: unknown[]; stop(): void } {
  const failures: unknown[] = []
  const onRejection = (reason: unknown): void => {
    failures.push(reason)
  }
  const onException = (error: unknown): void => {
    failures.push(error)
  }
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return {
    failures,
    stop: () => {
      process.off('unhandledRejection', onRejection)
      process.off('uncaughtException', onException)
    }
  }
}

/** Give timers and microtasks a chance to run, so a late throw would surface. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5))
}

let trap: ReturnType<typeof trapProcessFailures>

beforeEach(() => {
  trap = trapProcessFailures()
})

afterEach(() => {
  trap.stop()
})

function deferred<T>(): { promise: Promise<T>; release: (value: T) => void } {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

const IPMITOOL_VERSION = 'ipmitool version 1.8.18\n'
const POWER_ON = 'Chassis Power is on\n'
/** What a BMC that is not answering on UDP 623 looks like from ipmitool. */
const NO_SESSION = 'Error: Unable to establish IPMI v2 / RMCP+ session\n'

function machine(n: number, enabled = true): BmcMachine {
  return {
    id: `m${n}`,
    revision: `r${n}`,
    name: `Server ${n}`,
    ip: `10.0.0.${n}`,
    port: 623,
    username: 'admin',
    password: 'secret',
    enabled
  }
}

function fleet(count: number, sensorEverySweeps = 1): BmcConfig {
  return {
    version: 2,
    machines: Array.from({ length: count }, (_, index) => machine(index + 1)),
    settings: { ...defaultSettings(), sensorEverySweeps },
    hintsOn: true
  }
}

function isProbe(command: string): boolean {
  return command.includes('command -v ipmitool')
}

/**
 * Activate, get past the one-off ipmitool probe, and hand back the lifecycle
 * with the sweep poller already registered - the state the module is in for
 * every case below.
 */
async function started(harness: ModuleHarness): Promise<ReturnType<typeof activateBmc>> {
  const lifecycle = activateBmc(harness.ctx)
  lifecycle.applyPollers?.()
  await vi.waitFor(() => expect(harness.pollers[0]?.start).toHaveBeenCalledWith(60_000))
  return lifecycle
}

describe('work that outlives the module it belongs to', () => {
  it('a sweep still waiting on a BMC when the module stops writes nothing and reports nothing', async () => {
    const gate = deferred<ModuleExecResult>()
    const harness = moduleHarness(
      'bmc',
      (command) => {
        if (isProbe(command)) return { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
        if (command.includes('chassis power status')) return gate.promise
        return { stdout: '', stderr: '', code: 0 }
      },
      { config: sharedModuleConfig(fleet(1)) }
    )
    const lifecycle = await started(harness)

    // Not awaited on purpose: the read is in the air for the whole of the
    // dispose, which is the only way to reach the late-write path.
    const sweep = harness.ticks[0]()
    await vi.waitFor(() =>
      expect(harness.exec).toHaveBeenCalledWith(
        expect.stringContaining('chassis power status'),
        expect.anything()
      )
    )

    harness.emit.mockClear()
    lifecycle.dispose()
    harness.revoke()
    gate.release({ stdout: POWER_ON, stderr: '', code: 0 })
    await sweep
    await drain()

    expect(trap.failures).toEqual([])
    // The answer is discarded rather than published: a card painted from an
    // endpoint the user has just stopped monitoring is worse than no card.
    expect(harness.emit).not.toHaveBeenCalled()
    // The rule the ruleset states: nothing keeps using ctx after dispose().
    // `readState` decides whether to read sensors *after* the power read has
    // come back, so a sweep disposed mid-flight re-reads the settings document
    // through a torn-down store and then fires one more `ipmitool sdr elist`
    // per machine at a BMC the module has been told to stop touching.
    expect(harness.afterStopCalls).toEqual([])
  })

  it('a sweep disposed mid-flight issues no further ipmitool command of its own', async () => {
    const gate = deferred<ModuleExecResult>()
    const harness = moduleHarness(
      'bmc',
      (command) => {
        if (isProbe(command)) return { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
        if (command.includes('chassis power status')) return gate.promise
        return { stdout: '', stderr: '', code: 0 }
      },
      { config: sharedModuleConfig(fleet(1)) }
    )
    const lifecycle = await started(harness)

    const sweep = harness.ticks[0]()
    await vi.waitFor(() =>
      expect(harness.exec).toHaveBeenCalledWith(
        expect.stringContaining('chassis power status'),
        expect.anything()
      )
    )

    // Disposed but not revoked, which is what the module sees from `reset()`
    // as well: the context still works, so nothing but the module's own
    // liveness checks is standing between a stopped sweep and the endpoint.
    lifecycle.dispose()
    gate.release({ stdout: POWER_ON, stderr: '', code: 0 })
    await sweep
    await drain()

    const sensorReads = harness.exec.mock.calls.filter(([command]) =>
      command.includes('sdr elist')
    )
    expect(sensorReads).toEqual([])
    expect(trap.failures).toEqual([])
  })

  it('publishes no overview frame once the module has stopped, however it is prodded', async () => {
    const harness = moduleHarness(
      'bmc',
      (command) =>
        isProbe(command)
          ? { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
          : { stdout: '', stderr: NO_SESSION, code: 1 },
      { config: sharedModuleConfig(fleet(1)), activeStreams: ['machines', 'overview'] }
    )
    const lifecycle = await started(harness)

    // An unreachable machine is a critical one - the fleet state that makes
    // the Overview meter and the machine's card ask for attention. That is the
    // renderer's job now: this module publishes once per sweep and never on a
    // timer of its own, which is why there is no second poller below.
    await harness.ticks[0]()
    expect(harness.emit).toHaveBeenCalledWith(
      'overview',
      expect.objectContaining({ healthLevel: 2 })
    )

    lifecycle.dispose()
    harness.emit.mockClear()
    harness.revoke()

    // A sweep tick that was already scheduled can still land after dispose. It
    // must not push one more frame of a fleet nothing is watching any more.
    await harness.ticks[0]()
    await drain()

    expect(harness.emit).not.toHaveBeenCalled()
    expect(harness.afterStopCalls).toEqual([])
    expect(trap.failures).toEqual([])
  })

  it('registers exactly one poller, and dispose stops it', async () => {
    const harness = moduleHarness(
      'bmc',
      (command) =>
        isProbe(command)
          ? { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
          : { stdout: '', stderr: NO_SESSION, code: 1 },
      { config: sharedModuleConfig(fleet(1)), activeStreams: ['machines', 'overview'] }
    )
    const lifecycle = await started(harness)
    await harness.ticks[0]()

    // One poller: the sweep. The attention blink used to be a second one,
    // ticking every second for as long as anything was wrong; the app draws it
    // now, so the module went back to collecting on one cadence like every
    // other module.
    expect(harness.pollers).toHaveLength(1)

    // `applySweepPoller` stops the sweep poller before every restart, so what
    // matters is a *further* stop once dispose runs.
    const stoppedBefore = harness.pollers[0].stop.mock.calls.length
    lifecycle.dispose()
    // Without revoking, `afterStopCalls` can only ever be empty, so asserting
    // on it below would pass whatever the module did.
    harness.revoke()

    expect(harness.pollers[0].stop.mock.calls.length).toBeGreaterThan(stoppedBefore)
    expect(harness.afterStopCalls).toEqual([])
  })

  it('sweepNow called after dispose answers with a failure result rather than throwing', async () => {
    const harness = moduleHarness(
      'bmc',
      (command) =>
        isProbe(command)
          ? { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
          : { stdout: POWER_ON, stderr: '', code: 0 },
      { config: sharedModuleConfig(fleet(1)) }
    )
    const lifecycle = await started(harness)
    const sweepNow = harness.handlers.get('sweepNow')
    expect(sweepNow).toBeDefined()

    harness.emit.mockClear()
    lifecycle.dispose()
    harness.revoke()
    const result = await Promise.resolve(sweepNow!())
    await drain()

    // The host unregisters a stopped module's methods, so this is the
    // defensive path rather than one the app can reach - it still has to end
    // in an OkResult a caller can render, not in a rejection.
    expect(result).toEqual({ ok: false, error: expect.any(String) })
    expect(trap.failures).toEqual([])
    // The forced re-probe is the one thing it does reach for, and the revoked
    // context refuses it - which the probe catches rather than letting escape.
    expect(harness.afterStopCalls).toEqual(['exec'])
    // The stale probe result is not published: no page gets a capabilities
    // frame describing a module that has already gone.
    expect(harness.emit).not.toHaveBeenCalled()
  })

  it('machineRows called after dispose reads an empty fleet instead of a torn-down store', async () => {
    const harness = moduleHarness(
      'bmc',
      (command) =>
        isProbe(command)
          ? { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
          : { stdout: POWER_ON, stderr: '', code: 0 },
      { config: sharedModuleConfig(fleet(2)) }
    )
    const lifecycle = await started(harness)
    const machineRows = harness.handlers.get('machineRows')
    expect(machineRows).toBeDefined()
    expect(await machineRows!()).toHaveLength(2)

    lifecycle.dispose()
    harness.revoke()

    expect(await machineRows!()).toEqual([])
    expect(trap.failures).toEqual([])
    // It answers from its own disposed state rather than reaching for the
    // revoked context at all. A revoked `configGet` would answer null and the
    // reader would degrade to "no machines" either way, but the call is still
    // work outliving the module, and the host logs it as such.
    expect(harness.afterStopCalls).toEqual([])
  })
})
