import { describe, expect, it, vi } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult, ModuleMainInstance } from '@shared/modules'
import type { OkResult } from '@shared/types'
import {
  moduleHarness,
  sharedModuleConfig,
  type ModuleHarness,
  type SharedModuleConfig
} from '../helpers/module-harness'
import activateBmc from '../../bmc/main/index'
import type { MachineCard, MachinesPayload } from '../../bmc/main/sweep'
import type { MachineRow } from '../../bmc/main/machines'
import {
  DEFAULT_SETTINGS,
  machineFingerprint,
  type BmcConfig,
  type BmcMachine,
  type BmcSettings
} from '../../bmc/main/store'

/**
 * What happens to an answer that arrives too late to be true any more.
 *
 * A sweep is a network round trip to a controller with `-N 3 -R 2` behind it,
 * so the gap between "the module asked" and "the BMC replied" is seconds. In
 * that gap the user can rename the entry, re-point it at another address,
 * re-credential it, park it, delete it, or reset the module. The reading in
 * hand then describes an endpoint nobody asked about, and painting a card with
 * it is worse than painting no card at all: it is a green tile vouching for a
 * machine this module has not actually looked at.
 *
 * Four guards stand in the way, and every case below holds one sweep open with
 * a deferred `chassis power status` so exactly one of them can be exercised:
 *
 *   - a generation counter, bumped by `reset()` and `dispose()`
 *   - a per-machine `stateVersion`, bumped by `forgetMachine()`
 *   - a `machineFingerprint` comparison before any result is committed
 *   - a `stillWanted()` check between the power read and the sensor read
 *
 * The edits are made straight through the shared `SharedModuleConfig` rather
 * than through this module's own editor, because that is the case the
 * fingerprint exists for: the settings document is shared by every connected
 * machine's instance of the module, so an edit made from the other one lands
 * in the file without this instance's `stateVersions` ever moving. The
 * fingerprint is then the only thing left between the card and a stale answer.
 *
 * Since 0.6.0 the password is neither in that document nor in the fingerprint:
 * it lives in the app's encrypted secret store, keyed by machine id, and the
 * sweep fetches it per call. So "the password changed" is no longer something
 * the settings document can express by itself, and a stale reading cannot be
 * caught by comparing one. What a re-credential does leave behind is a new
 * `revision`, because the editor mints one on every apply - which is what the
 * first case below pins, and what the re-credential cases after it lean on.
 */

const IPMITOOL_VERSION = 'ipmitool version 1.8.18\n'
const POWER_ON = 'Chassis Power is on\n'

/** `ipmitool sdr elist` on a healthy chassis. */
const SDR_HEALTHY = [
  'Intrusion        | 73h | ok  |  7.1 |',
  'Fan1 RPM         | 30h | ok  |  7.1 | 3720 RPM',
  'Inlet Temp       | 04h | ok  |  7.1 | 23 degrees C',
  'Pwr Consumption  | 77h | ok  | 10.1 | 168 Watts',
  ''
].join('\n')

interface Deferred<T> {
  promise: Promise<T>
  release(value: T): void
}

function deferred<T>(): Deferred<T> {
  let release!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

/** Let timers and microtasks run, so anything still unwinding gets to finish. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5))
}

function machine(index: number, overrides: Partial<BmcMachine> = {}): BmcMachine {
  return {
    id: `m${index}`,
    revision: `r${index}`,
    name: `Server ${index}`,
    ip: `10.0.0.${index + 4}`,
    port: 623,
    username: 'admin',
    enabled: true,
    ...overrides
  }
}

/** What the secret store holds for those machines, keyed the way `Credentials` keys it. */
function secretsFor(machines: readonly BmcMachine[]): Record<string, string> {
  return Object.fromEntries(machines.map((entry) => [`machine/${entry.id}`, 'secret']))
}

/**
 * A settings document as it sits on disk. Every call builds fresh objects, so
 * writing one over the shared config really does replace the entries rather
 * than mutating the ones a sweep is already holding.
 */
function configDoc(
  machines: readonly BmcMachine[],
  settings: Partial<BmcSettings> = {}
): BmcConfig {
  return {
    // Version 3: no passwords in the document at all.
    version: 3,
    machines: machines.map((entry) => ({ ...entry })),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    hintsOn: true
  }
}

interface HeldModule {
  harness: ModuleHarness
  lifecycle: ModuleMainInstance
  /** The document on disk, as the other connected machine's instance sees it. */
  shared: SharedModuleConfig
  /** Let every waiting `chassis power status` answer at once. */
  release(): void
}

/**
 * An activated module whose power reads hang until `release()` is called - the
 * suspended sweep every case here needs.
 */
function heldModule(
  machines: readonly BmcMachine[],
  settings: Partial<BmcSettings> = {}
): HeldModule {
  const gate = deferred<ModuleExecResult>()
  const shared = sharedModuleConfig(configDoc(machines, settings))
  const harness = moduleHarness(
    'bmc',
    (command) => {
      if (command.includes('command -v ipmitool')) {
        return { stdout: IPMITOOL_VERSION, stderr: '', code: 0 }
      }
      // Held rather than answered: this is the window the guards exist for.
      if (command.includes('chassis power status')) return gate.promise
      if (command.includes('sdr elist')) return { stdout: SDR_HEALTHY, stderr: '', code: 0 }
      if (command.includes('chassis power on')) return { stdout: '', stderr: '', code: 0 }
      return { stdout: '', stderr: `no fixture for: ${command}`, code: 1 }
    },
    { config: shared, secrets: secretsFor(machines) }
  )
  const lifecycle = activateBmc(harness.ctx)
  return {
    harness,
    lifecycle,
    shared,
    release: () => gate.release({ stdout: POWER_ON, stderr: '', code: 0 })
  }
}

function handler(harness: ModuleHarness, method: string): (...args: unknown[]) => unknown {
  const found = harness.handlers.get(method)
  if (!found) throw new Error(`the module never registered a ${method} handler`)
  return found
}

/**
 * A manual sweep. Deliberately not awaited at the call sites below - the whole
 * point is to leave one running while the document changes underneath it.
 */
function sweepNow(harness: ModuleHarness): Promise<OkResult> {
  return Promise.resolve(handler(harness, 'sweepNow')()) as Promise<OkResult>
}

/**
 * The settings table, which reads the sweeper's per-machine state directly.
 * Async since 0.6.0: it asks the secret store what each row's credential is
 * before it builds a line.
 */
async function machineRows(harness: ModuleHarness): Promise<MachineRow[]> {
  return (await handler(harness, 'machineRows')()) as MachineRow[]
}

/**
 * Make the module publish a fresh frame without sweeping again. The hints
 * switch is the cheapest thing wired to `sweeper.publishCards()`, so it shows
 * what the sweeper is holding at this instant rather than what it published
 * during some earlier pass.
 */
function republishCards(harness: ModuleHarness): void {
  const result = handler(harness, 'hintsSet')({ hintsOn: false }) as OkResult
  expect(result.ok).toBe(true)
}

function machinesFrames(harness: ModuleHarness): MachinesPayload[] {
  const calls = harness.emit.mock.calls as unknown as ReadonlyArray<readonly [string, unknown]>
  return calls.filter((call) => call[0] === 'machines').map((call) => call[1] as MachinesPayload)
}

function lastMachines(harness: ModuleHarness): MachinesPayload {
  const last = machinesFrames(harness).at(-1)
  if (!last) throw new Error('the module never emitted a machines payload')
  return last
}

function cardFor(payload: MachinesPayload, id: string): MachineCard {
  const card = payload.machines.find((entry) => entry.id === id)
  if (!card) throw new Error(`the payload carries no card for ${id}`)
  return card
}

function commandsOf(harness: ModuleHarness): string[] {
  return harness.exec.mock.calls.map((call) => call[0])
}

/** How many ipmitool invocations matched every one of these fragments. */
function countOf(harness: ModuleHarness, ...fragments: string[]): number {
  return commandsOf(harness).filter((command) =>
    fragments.every((fragment) => command.includes(fragment))
  ).length
}

/** Wait until the sweep is genuinely suspended on its power reads. */
async function waitForPowerReads(harness: ModuleHarness, count: number): Promise<void> {
  await vi.waitFor(() => expect(countOf(harness, 'chassis power status')).toBe(count))
}

/** `reset` is optional on the lifecycle, so a missing one must fail loudly. */
function resetModule(lifecycle: ModuleMainInstance): void {
  if (!lifecycle.reset) throw new Error('the module has no reset hook')
  lifecycle.reset()
}

/** The document as the other connected machine's instance would see it on disk. */
function stored(shared: SharedModuleConfig): BmcMachine[] {
  return (shared.get() as BmcConfig).machines
}

describe('what a re-credential leaves behind for the guards to catch', () => {
  it('moves the revision when only the password changed, which is the only trace a new credential leaves', async () => {
    // This is the premise the two re-credential cases below rest on. The
    // password is no longer in the settings document and no longer in
    // `machineFingerprint`, so if an apply that changed nothing else left the
    // entry byte-identical there would be nothing at all between a card and a
    // reply to the credential the machine has just stopped using.
    const { harness, shared, release } = heldModule([machine(1)], { sensorEverySweeps: 0 })
    const before = stored(shared)[0]

    const values = {
      name: before.name,
      ip: before.ip,
      port: String(before.port),
      username: before.username,
      password: 'rotated-after-the-audit',
      note: ''
    }
    const report = (await handler(harness, 'machineCheck')('m1', 'r1', values)) as ModuleCheckReport
    expect(report.ok).toBe(true)
    const applied = (await handler(harness, 'machineApply')('m1', 'r1', {
      token: report.token,
      values
    })) as OkResult
    expect(applied).toEqual({ ok: true })

    const after = stored(shared)[0]
    expect(after.revision).not.toBe(before.revision)
    expect(machineFingerprint(after)).not.toBe(machineFingerprint(before))
    // Nothing else about the entry moved - the revision is doing all the work.
    expect({ ...after, revision: before.revision }).toEqual(before)
    // And the password went to the store rather than into the document.
    expect(after).not.toHaveProperty('password')
    expect(await harness.ctx.secretGet('machine/m1')).toBe('rotated-after-the-audit')

    release()
    await drain()
  })

  it('leaves the credential where the sweep will find it, without a document write per read', async () => {
    // The store, not the document, is what a sweep asks - so the settings file
    // an editor writes stays free of anything secret and every guard in this
    // file goes on comparing values it is safe to hold in memory.
    const { harness, shared, release } = heldModule([machine(1), machine(2)], {
      sensorEverySweeps: 0
    })

    expect(stored(shared).every((entry) => entry.password === undefined)).toBe(true)
    expect((shared.get() as BmcConfig).version).toBe(3)
    expect(await harness.ctx.secretList()).toEqual([
      { key: 'machine/m1', updatedAt: 0, readable: true },
      { key: 'machine/m2', updatedAt: 0, readable: true }
    ])

    release()
    await drain()
  })
})

describe('a sweep whose reading lands after the machine changed under it', () => {
  it('never paints a card with an answer taken before the entry was renamed and its revision moved', async () => {
    const { harness, shared, release } = heldModule([machine(1)], { sensorEverySweeps: 0 })

    const sweep = sweepNow(harness)
    await waitForPowerReads(harness, 1)
    shared.set(
      configDoc([machine(1, { name: 'Rack B head node', revision: 'r1-renamed' })], {
        sensorEverySweeps: 0
      })
    )
    release()
    await sweep

    // The whole rule in one assertion: a card must never show what an endpoint
    // said before the user re-pointed the entry at it.
    const card = cardFor(lastMachines(harness), 'm1')
    expect(card.revision).toBe('r1-renamed')
    expect(card.powerLabel).toBe('Not checked yet')
    expect(card.summary).toBe('Waiting for the first sweep')
    expect(lastMachines(harness).counts.unknown).toBe(1)

    // And the reading was dropped rather than filed under the revision it was
    // taken against: putting the old entry back finds nothing waiting for it.
    shared.set(configDoc([machine(1)], { sensorEverySweeps: 0 }))
    expect((await machineRows(harness))[0]).toMatchObject({
      revision: 'r1',
      powerLabel: 'Not checked yet'
    })
  })

  it('discards a reading when the address moved even though the revision did not', async () => {
    // The revision is deliberately left alone here. Only the fingerprint can
    // catch this, and it is the case that matters most: the answer in hand came
    // from a controller at an address this entry no longer points at.
    const { harness, shared, release } = heldModule([machine(1)], { sensorEverySweeps: 0 })

    const sweep = sweepNow(harness)
    await waitForPowerReads(harness, 1)
    shared.set(configDoc([machine(1, { ip: '10.0.0.90' })], { sensorEverySweeps: 0 }))
    release()
    await sweep

    const card = cardFor(lastMachines(harness), 'm1')
    expect(card.ip).toBe('10.0.0.90')
    expect(card.revision).toBe('r1')
    expect(card.powerLabel).toBe('Not checked yet')
  })

  it('discards a reading taken with the credentials the machine had before it was re-credentialed', async () => {
    // What an apply on the other connected machine's instance leaves in the
    // document: same name, same address, same user, same everything - and a
    // new revision, which is the whole of the difference. The reply in hand
    // was authenticated with the password that entry has just stopped using,
    // so it cannot be allowed to certify the one that now holds the new one.
    const { harness, shared, release } = heldModule([machine(1)], { sensorEverySweeps: 0 })

    const sweep = sweepNow(harness)
    await waitForPowerReads(harness, 1)
    const recredentialed = machine(1, { revision: 'r1-recredentialed' })
    expect({ ...recredentialed, revision: 'r1' }).toEqual(machine(1))
    shared.set(configDoc([recredentialed], { sensorEverySweeps: 0 }))
    release()
    await sweep

    const card = cardFor(lastMachines(harness), 'm1')
    expect(card.revision).toBe('r1-recredentialed')
    expect(card.powerLabel).toBe('Not checked yet')
    expect((await machineRows(harness))[0].powerLabel).toBe('Not checked yet')
  })

  it('discards a reading for a machine parked mid-read, and reports it as parked', async () => {
    const { harness, shared, release } = heldModule([machine(1)], { sensorEverySweeps: 0 })

    const sweep = sweepNow(harness)
    await waitForPowerReads(harness, 1)
    shared.set(configDoc([machine(1, { enabled: false })], { sensorEverySweeps: 0 }))
    release()
    await sweep

    const card = cardFor(lastMachines(harness), 'm1')
    expect(card.enabled).toBe(false)
    expect(card.powerLabel).toBe('Sweeping disabled')
    expect(card.summary).toBe('Parked - not being swept')
    expect(lastMachines(harness).counts).toMatchObject({ disabled: 1, monitored: 0, on: 0 })

    // A parked card reads the same whether or not the answer was kept, so the
    // card alone proves nothing. Resuming the machine - same revision, only
    // `enabled` back - is what shows the reading was actually thrown away, and
    // it is why `enabled` is part of the fingerprint at all.
    shared.set(configDoc([machine(1)], { sensorEverySweeps: 0 }))
    expect((await machineRows(harness))[0]).toMatchObject({
      revision: 'r1',
      enabled: true,
      powerLabel: 'Not checked yet'
    })
  })

  it('drops a reading for a machine deleted mid-sweep and leaves no card behind for it', async () => {
    const { harness, shared, release } = heldModule([machine(1), machine(2)], {
      sensorEverySweeps: 0
    })

    const sweep = sweepNow(harness)
    await waitForPowerReads(harness, 2)
    shared.set(configDoc([machine(2)], { sensorEverySweeps: 0 }))
    release()
    await sweep

    const payload = lastMachines(harness)
    expect(payload.machines.map((card) => card.id)).toEqual(['m2'])
    // The machine still on the list is swept as normal: one entry's answer is
    // discarded, not the whole pass.
    expect(cardFor(payload, 'm2').powerLabel).toBe('Power on')

    // Nothing orphaned: re-adding the deleted entry does not resurrect the
    // reading the module took just before it went.
    shared.set(configDoc([machine(1), machine(2)], { sensorEverySweeps: 0 }))
    expect((await machineRows(harness)).map((row) => row.powerLabel)).toEqual([
      'Not checked yet',
      'Power on'
    ])
  })
})

describe('the stillWanted() gate between the power read and the sensor read', () => {
  it('sends no sdr read to a machine deleted through the module while its power read was in the air', async () => {
    // The one place this module could reach an endpoint it has been told to
    // stop touching: the power read can take fifteen seconds, and the sensor
    // read that follows it would go out with the old credentials, to an
    // address the entry no longer holds. Deleting through the module's own
    // handler is the path that moves this machine's stateVersion.
    const { harness, release } = heldModule([machine(1), machine(2)], { sensorEverySweeps: 1 })

    const sweep = sweepNow(harness)
    await waitForPowerReads(harness, 2)
    // Async since the row and its stored password are removed together.
    const deleted = (await handler(harness, 'machineDelete')('m1', 'r1')) as OkResult
    expect(deleted.ok).toBe(true)
    // The credential went with the row rather than being orphaned in the store.
    expect(await harness.ctx.secretGet('machine/m1')).toBeNull()

    release()
    await sweep
    await drain()

    expect(countOf(harness, 'sdr elist', "-H '10.0.0.5'")).toBe(0)
    // Its neighbour, which nobody touched, still gets its sensor read - so the
    // gate is about the deleted entry, not about the sweep giving up.
    expect(countOf(harness, 'sdr elist', "-H '10.0.0.6'")).toBe(1)
  })

  it('sends no sdr read to a machine parked through the module while its power read was in the air', async () => {
    // The same gate reached by the other edit that stops a machine being
    // swept. Parking keeps the entry on the list, where deleting takes it off,
    // and both go through `forgetMachine` - so this is the deleted case above
    // with one thing changed.
    const { harness, release } = heldModule([machine(1), machine(2)], { sensorEverySweeps: 1 })

    const sweep = sweepNow(harness)
    await waitForPowerReads(harness, 2)
    const parked = handler(harness, 'machineEnable')('m1', 'r1') as OkResult
    expect(parked).toMatchObject({ ok: true, data: 'Sweeping paused' })

    release()
    await sweep
    await drain()

    expect(countOf(harness, 'sdr elist', "-H '10.0.0.5'")).toBe(0)
    expect(countOf(harness, 'sdr elist', "-H '10.0.0.6'")).toBe(1)
  })

  it('sends no sdr read at all once the module has been reset under the sweep', async () => {
    const { harness, lifecycle, release } = heldModule([machine(1), machine(2)], {
      sensorEverySweeps: 1
    })

    const sweep = sweepNow(harness)
    await waitForPowerReads(harness, 2)
    resetModule(lifecycle)

    release()
    await sweep
    await drain()

    // The results are discarded either way; the point of stopping between the
    // two commands is not to send the second one at all.
    expect(countOf(harness, 'sdr elist')).toBe(0)
  })

  it('throws away every in-flight result when the module is reset mid-sweep', async () => {
    const { harness, lifecycle, release } = heldModule([machine(1), machine(2)], {
      sensorEverySweeps: 0
    })

    const sweep = sweepNow(harness)
    await waitForPowerReads(harness, 2)
    resetModule(lifecycle)
    harness.emit.mockClear()

    release()
    await sweep
    await drain()

    // A sweep from an abandoned generation publishes nothing at all, rather
    // than a frame of cards nobody asked for.
    expect(machinesFrames(harness)).toHaveLength(0)

    republishCards(harness)
    const payload = lastMachines(harness)
    expect(payload.machines.map((card) => card.powerLabel)).toEqual([
      'Not checked yet',
      'Not checked yet'
    ])
    expect(payload.counts).toMatchObject({ monitored: 2, unknown: 2, on: 0 })
  })
})

describe('the re-read a power action asks for', () => {
  it('discards its result when the machine changed while the follow-up read was in the air', async () => {
    // `refreshOne` runs the same guards as a sweep, which matters because it is
    // the read most likely to overlap an edit: the user is on the card, and the
    // machine is being changed from somewhere else at the same moment.
    const { harness, shared, release } = heldModule([machine(1)], { sensorEverySweeps: 0 })

    const pending = handler(harness, 'powerAction')('m1', 'r1', 'on') as Promise<OkResult>
    await waitForPowerReads(harness, 1)
    shared.set(
      configDoc([machine(1, { revision: 'r1-recredentialed' })], { sensorEverySweeps: 0 })
    )
    release()

    // The action itself did happen and is reported as such - it is only the
    // reading taken afterwards that is no longer about this entry.
    expect(await pending).toEqual({ ok: true })
    await drain()

    // `refreshOne` publishes only when it commits, so a frame that never
    // arrived is the discard.
    expect(machinesFrames(harness)).toHaveLength(0)
    expect((await machineRows(harness))[0]).toMatchObject({
      revision: 'r1-recredentialed',
      powerLabel: 'Not checked yet'
    })
  })
})

describe('two sweeps asked for at once', () => {
  it('joins a second request to the pass already running instead of asking the fleet twice', async () => {
    const { harness, release } = heldModule([machine(1), machine(2)], { sensorEverySweeps: 0 })

    const first = sweepNow(harness)
    await waitForPowerReads(harness, 2)
    const second = sweepNow(harness)
    await drain()
    release()

    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }])
    // Two presses of "sweep now" over one pass: two machines, two commands.
    expect(countOf(harness, 'chassis power status')).toBe(2)
    // Both calls really did run - each forces its own probe of the management
    // machine before it asks for a sweep - so the count above is coalescing
    // rather than the second call having quietly done nothing.
    expect(countOf(harness, 'command -v ipmitool')).toBe(2)
  })

  it('does not let a sweep asked for after a reset join the pass that reset abandoned', async () => {
    const { harness, lifecycle, release } = heldModule([machine(1)], { sensorEverySweeps: 0 })

    const first = sweepNow(harness)
    await waitForPowerReads(harness, 1)
    resetModule(lifecycle)
    const second = sweepNow(harness)
    await drain()
    release()
    await Promise.all([first, second])
    await drain()

    // The new generation waits for the abandoned pass to unwind and then asks
    // the machine again, rather than adopting an answer taken before the reset.
    expect(countOf(harness, 'chassis power status')).toBe(2)
    expect(cardFor(lastMachines(harness), 'm1').powerLabel).toBe('Power on')
  })
})
