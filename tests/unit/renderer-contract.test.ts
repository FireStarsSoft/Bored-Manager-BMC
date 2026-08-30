import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type {
  AttentionWhen,
  Block,
  FormBlock,
  MeterBlock,
  PageSpec,
  StatusCardsBlock,
  WidgetSpec
} from '@shared/module-ui'
import type { ModuleExecResult, ModuleMainInstance, ModuleManifest } from '@shared/modules'
import type { OkResult } from '@shared/types'
import {
  moduleHarness,
  sharedModuleConfig,
  type ModuleHandler,
  type ModuleHarness,
  type ModuleHarnessOptions
} from '../helpers/module-harness'
import activateBmc from '../../bmc/main/index'
import type { MachineRow } from '../../bmc/main/machines'
import type { BmcCapabilities, UiState } from '../../bmc/main/runtime'
import type { OverviewPayload } from '../../bmc/main/sweep'
import { defaultSettings, type BmcConfig, type BmcMachine } from '../../bmc/main/store'

/**
 * The shapes the real renderer sends, and the ones it reads back.
 *
 * Every defect pinned here shipped past a suite that was entirely green,
 * because the tests around each one encoded a convention the app does not
 * actually use. A `form` block was tested as if it posted `{ key: value }`
 * when FormBlock.tsx posts its fields positionally, so the hints switch was a
 * one-way door. Readiness was tested against `buildReadiness` directly rather
 * than against what reaches the `capabilities` stream, so two handlers that
 * changed the number of swept machines and never republished looked fine.
 * `snapshots()` was tested for the streams it names, not for values the host
 * will keep - and `seedModuleSnapshots` skips any snapshot that is `== null`,
 * so a null overview leaves the stream unset and the widget says the fleet is
 * empty over a configured one.
 *
 * So everything below is asserted at the boundary: handlers as the host
 * registered them, payloads as they were emitted, and calls assembled from the
 * module's own spec files in the order the renderer would assemble them.
 *
 * 0.6.0 added a fourth binding of exactly this kind. `attention` and
 * `attentionKey` tell the app when something is urgent, and both are read out
 * of a payload by name - so a renamed field costs the module nothing, breaks
 * no test that checks shapes in isolation, and simply stops the one card that
 * should have been moving from moving. There is nothing to see on the page.
 */

const ID = 'bmc'
const ROOT = join(process.cwd(), ID)

const manifest = JSON.parse(readFileSync(join(ROOT, 'module.json'), 'utf8')) as ModuleManifest

function page(id: string): PageSpec {
  return JSON.parse(readFileSync(join(ROOT, 'ui', 'pages', `${id}.json`), 'utf8')) as PageSpec
}

function widget(id: string): WidgetSpec {
  return JSON.parse(readFileSync(join(ROOT, 'ui', 'widgets', `${id}.json`), 'utf8')) as WidgetSpec
}

/** A dot-path out of a payload, resolved the way src/modules/binding.ts does. */
function valueAt(payload: unknown, path?: string): unknown {
  if (!path) return payload
  return path
    .split('.')
    .reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], payload)
}

/**
 * Every block in a spec, however deeply nested. The five ways a block holds
 * other blocks are `blocks`, a conditional's `else`, a table/statusCards
 * `rowDetail`, and a subnav item's own list - and the boot-device form lives
 * inside a drawer, so a walk that skips `rowDetail` finds nothing at all.
 */
function allBlocks(blocks: readonly Block[] | undefined): Block[] {
  const out: Block[] = []
  for (const block of blocks ?? []) {
    out.push(block)
    if (block.type === 'section' || block.type === 'conditional') out.push(...allBlocks(block.blocks))
    if (block.type === 'conditional') out.push(...allBlocks(block.else))
    if (block.type === 'table' || block.type === 'statusCards') out.push(...allBlocks(block.rowDetail))
    if (block.type === 'subnav') {
      for (const item of block.items) out.push(...allBlocks(item.blocks))
    }
  }
  return out
}

/** The one `form` block on a page that submits to `method`. */
function formFor(spec: PageSpec, method: string): FormBlock {
  const forms = allBlocks(spec.blocks).filter(
    (block): block is FormBlock => block.type === 'form' && block.submit.method === method
  )
  if (forms.length !== 1) {
    throw new Error(`expected exactly one \`form\` block submitting to ${method}, found ${forms.length}`)
  }
  return forms[0]
}

/** The one `block` of `type` anywhere in a spec. */
function onlyBlock<T extends Block['type']>(
  spec: PageSpec | WidgetSpec,
  type: T
): Extract<Block, { type: T }> {
  const found = allBlocks(spec.blocks).filter(
    (block): block is Extract<Block, { type: T }> => block.type === type
  )
  if (found.length !== 1) throw new Error(`expected exactly one \`${type}\` block, found ${found.length}`)
  return found[0]
}

const MC_INFO = [
  'Device ID                 : 32',
  'Firmware Revision         : 3.88',
  'IPMI Version              : 2.0',
  'Manufacturer Name         : Supermicro',
  'Product Name              : X11DPU',
  ''
].join('\n')

/** A management station with ipmitool, and controllers that answer everything. */
function healthyFleet(command: string): ModuleExecResult {
  if (command.includes('command -v ipmitool')) {
    return { stdout: 'ipmitool version 1.8.18\n', stderr: '', code: 0 }
  }
  if (command.includes('mc info')) return { stdout: MC_INFO, stderr: '', code: 0 }
  if (command.includes('chassis power status')) {
    return { stdout: 'Chassis Power is on\n', stderr: '', code: 0 }
  }
  return { stdout: '', stderr: '', code: 0 }
}

function machine(over: Partial<BmcMachine> = {}): BmcMachine {
  return {
    id: 'm1',
    revision: 'r1',
    name: 'Rack A chassis',
    ip: '10.0.0.5',
    port: 623,
    username: 'operator',
    enabled: true,
    ...over
  }
}

/**
 * A version 3 document: the passwords are in the app's secret store from 0.6.0
 * onwards, and this file is where the migration has already finished. A
 * version 2 document here would have `activate` quietly rewriting it under
 * every assertion about what is "on disk".
 */
function documentWith(machines: BmcMachine[], hintsOn = true): BmcConfig {
  return { version: 3, machines, settings: defaultSettings(), hintsOn }
}

/** What the secret store holds for a fleet: one readable password per machine. */
function passwordsFor(machines: BmcMachine[]): Record<string, string> {
  return Object.fromEntries(machines.map((entry) => [`machine/${entry.id}`, 'hunter2']))
}

interface Rig {
  harness: ModuleHarness
  lifecycle: ModuleMainInstance
  /** The settings document as it now stands on "disk", not the store's cache. */
  stored(): BmcConfig
}

/** The module as the host starts it: activated, with its handlers registered. */
function rig(
  machines: BmcMachine[],
  options: Omit<ModuleHarnessOptions, 'config'> & { hintsOn?: boolean } = {},
  answer: (command: string) => ModuleExecResult = healthyFleet
): Rig {
  const { hintsOn = true, ...harnessOptions } = options
  const config = sharedModuleConfig(documentWith(machines, hintsOn))
  const harness = moduleHarness(ID, answer, {
    secrets: passwordsFor(machines),
    ...harnessOptions,
    config
  })
  return {
    harness,
    lifecycle: activateBmc(harness.ctx),
    stored: () => config.get() as BmcConfig
  }
}

/**
 * The same module after the ipmitool probe has answered. Readiness is
 * `connecting` until then whatever the fleet looks like, so a test about the
 * fleet has to wait for the probe or it is only ever asserting the probe.
 */
async function probedRig(
  machines: BmcMachine[],
  options: Omit<ModuleHarnessOptions, 'config'> & { hintsOn?: boolean } = {},
  answer: (command: string) => ModuleExecResult = healthyFleet
): Promise<Rig> {
  const r = rig(machines, options, answer)
  r.lifecycle.applyPollers?.()
  await vi.waitFor(() => {
    expect(capabilityEmits(r.harness).at(-1)?.probed).toBe(true)
  })
  return r
}

function handler(harness: ModuleHarness, method: string): ModuleHandler {
  const registered = harness.handlers.get(method)
  if (!registered) throw new Error(`the module never registered a "${method}" handler`)
  return registered
}

/** Call a handler the way the host does - by name, with positional arguments. */
async function call(harness: ModuleHarness, method: string, ...args: unknown[]): Promise<OkResult> {
  return (await handler(harness, method)(...args)) as OkResult
}

function emitsOf<T>(harness: ModuleHarness, event: string): T[] {
  return harness.emit.mock.calls.filter((c) => c[0] === event).map((c) => c[1] as T)
}

function capabilityEmits(harness: ModuleHarness): BmcCapabilities[] {
  return emitsOf<BmcCapabilities>(harness, 'capabilities')
}

function uiEmits(harness: ModuleHarness): UiState[] {
  return emitsOf<UiState>(harness, 'ui')
}

/**
 * `machineRows` is async now: a row says whether a password is saved, and that
 * answer comes from `ctx.secretList`. Awaiting it here is not a detail - a
 * caller that forgot would get a Promise and read `undefined` off it, which is
 * exactly what the table would do.
 */
async function rows(harness: ModuleHarness): Promise<MachineRow[]> {
  return (await handler(harness, 'machineRows')()) as MachineRow[]
}

function snapshotsOf(lifecycle: ModuleMainInstance): Record<string, unknown> {
  const snapshot = lifecycle.snapshots?.()
  if (!snapshot) throw new Error('the module answered no snapshots at all')
  return snapshot
}

/* ------------------------------------------------------------------------ */
/* (1) a `form` block submits positionally                                   */
/* ------------------------------------------------------------------------ */

/**
 * What the renderer sends for the hints switch, built the way it builds it:
 * `positionalFormValues(fields, values)` in field order, then
 * `resolveActionArgs` puts `argsFromRow` in front (there are none here).
 */
function hintsArgs(checked: boolean): unknown[] {
  const form = formFor(page('settings'), 'hintsSet')
  return [
    ...(form.submit.argsFromRow ?? []),
    ...form.fields.map((field) => (field.key === 'hintsOn' ? checked : ''))
  ]
}

describe('the hints switch: a `form` submits its fields positionally, not as an object', () => {
  it('is declared as a `form` with one checkbox, which is what makes its submit positional', () => {
    const form = formFor(page('settings'), 'hintsSet')

    // `checkForm` is the block that sends `{ token, values }`; `form` is not
    // it, and the difference is the whole defect.
    expect(form.type).toBe('form')
    expect(form.fields.map((field) => field.key)).toEqual(['hintsOn'])
    expect(form.fields[0].input).toBe('checkbox')
    expect(form.submit.argsFromRow ?? []).toEqual([])
  })

  it('turns hints on from the bare positional call the renderer actually makes', async () => {
    const r = rig([], { hintsOn: false })

    const result = await call(r.harness, 'hintsSet', ...hintsArgs(true))

    expect(result).toEqual({ ok: true })
    expect(r.stored().hintsOn).toBe(true)
    // The pages read the flag off the stream, not off the config file.
    expect(uiEmits(r.harness).at(-1)?.hintsOn).toBe(true)
  })

  it('turns hints off from the same call with an unticked box', async () => {
    const r = rig([], { hintsOn: true })

    const result = await call(r.harness, 'hintsSet', ...hintsArgs(false))

    expect(result).toEqual({ ok: true })
    expect(r.stored().hintsOn).toBe(false)
    expect(uiEmits(r.harness).at(-1)?.hintsOn).toBe(false)
  })

  it('still accepts the wrapped shape a checkForm would send, so neither convention breaks it', async () => {
    const wrapped = rig([], { hintsOn: false })
    const asText = rig([], { hintsOn: false })

    await call(wrapped.harness, 'hintsSet', { hintsOn: true })
    await call(asText.harness, 'hintsSet', { hintsOn: 'true' })

    expect(wrapped.stored().hintsOn).toBe(true)
    expect(uiEmits(wrapped.harness).at(-1)?.hintsOn).toBe(true)
    expect(asText.stored().hintsOn).toBe(true)
    expect(uiEmits(asText.harness).at(-1)?.hintsOn).toBe(true)
  })

  it.each([
    { name: 'nothing at all', args: [] as unknown[] },
    { name: 'an explicit undefined', args: [undefined] },
    { name: 'a falsy number', args: [0] },
    { name: 'a string that is not "true"', args: ['nonsense'] }
  ])('reads $name as an unticked box rather than as a tick', async ({ args }) => {
    const r = rig([], { hintsOn: true })

    await call(r.harness, 'hintsSet', ...args)

    expect(r.stored().hintsOn).toBe(false)
    expect(uiEmits(r.harness).at(-1)?.hintsOn).toBe(false)
  })

  it('is not a one-way door: on, off, and back on all land', async () => {
    // The assertion the original tests could not make. Reading only the
    // wrapped shape resolved every save to `false`, so the off worked, the
    // second on did not, and nothing in the suite ever asked for both.
    const r = rig([], { hintsOn: true })

    await call(r.harness, 'hintsSet', ...hintsArgs(false))
    expect(r.stored().hintsOn).toBe(false)

    await call(r.harness, 'hintsSet', ...hintsArgs(true))

    expect(r.stored().hintsOn).toBe(true)
    // Activation publishes the first one, so the run is the whole round trip.
    expect(uiEmits(r.harness).map((state) => state.hintsOn)).toEqual([true, false, true])
  })
})

describe('bootDevSet: the module’s other form submit, which was positional all along', () => {
  it('takes one argument per thing management.json sends, in that order', () => {
    const form = formFor(page('management'), 'bootDevSet')
    const sent = [...(form.submit.argsFromRow ?? []), ...form.fields.map((field) => field.key)]

    expect(sent).toEqual(['id', 'revision', 'device', 'persistent'])
    // A handler written to the wrapped convention would declare three
    // parameters and report 3 here; a rest parameter reports 0. Four named
    // ones is what makes the renderer's four values land in the right slots.
    expect(handler(rig([machine()]).harness, 'bootDevSet').length).toBe(sent.length)
  })

  it('issues "chassis bootdev pxe options=persistent" for a call assembled from the spec', async () => {
    const r = rig([machine()])
    const form = formFor(page('management'), 'bootDevSet')
    const row = (await rows(r.harness))[0]
    // `coerceFormValues`: a select arrives as its string value, a checkbox as
    // a real boolean - and `persistent` is only honoured when it is `true`.
    const submitted: Record<string, unknown> = { device: 'pxe', persistent: true }
    const args = [
      ...(form.submit.argsFromRow ?? []).map((key) => row[key]),
      ...form.fields.map((field) => submitted[field.key])
    ]

    const result = await call(r.harness, 'bootDevSet', ...args)

    expect(result).toEqual({ ok: true })
    const commands = r.harness.exec.mock.calls.map((exec) => exec[0])
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('chassis bootdev pxe options=persistent')
  })
})

/* ------------------------------------------------------------------------ */
/* (2) readiness is republished whenever the swept count changes             */
/* ------------------------------------------------------------------------ */

/** The values the Add-a-machine `checkForm` posts, as `coerceFormValues` builds them. */
function addValues(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Compute node 7',
    ip: '10.0.0.120',
    port: '623',
    username: 'operator',
    password: 'hunter2',
    enabled: true,
    note: '',
    ...over
  }
}

/** What the apply half sends: the checked values with every `omitOnApply` field blanked. */
function appliedValues(values: Record<string, unknown>): Record<string, unknown> {
  return { ...values, password: '' }
}

/** check then apply, in the two calls CheckFormBlock makes. */
async function addMachine(harness: ModuleHarness): Promise<OkResult> {
  const values = addValues()
  const report = (await handler(harness, 'machineCheck')(values)) as ModuleCheckReport
  expect(report.ok).toBe(true)
  return call(harness, 'machineApply', { token: report.token, values: appliedValues(values) })
}

describe('readiness is republished whenever the number of swept machines changes', () => {
  it('starts at "attention" while no machine has been added', async () => {
    const r = await probedRig([])

    const latest = capabilityEmits(r.harness).at(-1)
    expect(latest?.state).toBe('attention')
    expect(latest?.stateLabel).toMatch(/no bmc machines/i)
  })

  it('republishes as "ready" once the first machine is applied', async () => {
    // The user's first BMC. Without the republish every spec goes on gating
    // its whole layout on the "attention" payload from before the apply, and
    // the pages say nothing is being swept over a working fleet.
    const r = await probedRig([])
    const before = capabilityEmits(r.harness).length

    const applied = await addMachine(r.harness)

    expect(applied.ok).toBe(true)
    const after = capabilityEmits(r.harness)
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)?.state).toBe('ready')
  })

  it('republishes as "attention" once the last machine is deleted', async () => {
    const r = await probedRig([machine()])
    expect(capabilityEmits(r.harness).at(-1)?.state).toBe('ready')
    const before = capabilityEmits(r.harness).length

    const removed = await call(r.harness, 'machineDelete', 'm1', 'r1')

    expect(removed.ok).toBe(true)
    const after = capabilityEmits(r.harness)
    expect(after.length).toBeGreaterThan(before)
    expect(after.at(-1)?.state).toBe('attention')
    expect(after.at(-1)?.stateLabel).toMatch(/no bmc machines/i)
  })

  it('republishes when the only machine is parked, and again when it resumes', async () => {
    const r = await probedRig([machine()])

    const parked = await call(r.harness, 'machineEnable', 'm1', 'r1')

    expect(parked.ok).toBe(true)
    expect(capabilityEmits(r.harness).at(-1)?.state).toBe('attention')
    expect(capabilityEmits(r.harness).at(-1)?.stateLabel).toMatch(/parked/i)

    // Parking moves the revision, so the resume has to come off the row the
    // table now shows - exactly as a second click in the UI would.
    const row = (await rows(r.harness))[0]
    const resumed = await call(r.harness, 'machineEnable', row.id, row.revision)

    expect(resumed.ok).toBe(true)
    expect(capabilityEmits(r.harness).at(-1)?.state).toBe('ready')
  })

  it('does not republish when an apply is refused for a stale revision', async () => {
    const r = await probedRig([machine()])
    const values = addValues({ name: 'Rack A chassis renamed', ip: '10.0.0.5' })
    const report = (await handler(r.harness, 'machineCheck')('m1', 'r1', values)) as ModuleCheckReport
    expect(report.ok).toBe(true)
    const before = capabilityEmits(r.harness).length

    const applied = await call(r.harness, 'machineApply', 'm1', 'r-older', {
      token: report.token,
      values: appliedValues(values)
    })

    expect(applied.ok).toBe(false)
    // Nothing was written, so the swept count is what it was - and a
    // republish here would be a second identical payload every page re-renders on.
    expect(capabilityEmits(r.harness)).toHaveLength(before)
    expect(capabilityEmits(r.harness).at(-1)?.state).toBe('ready')
  })

  it('does not republish when a delete is refused for a stale revision', async () => {
    const r = await probedRig([machine()])
    const before = capabilityEmits(r.harness).length

    const removed = await call(r.harness, 'machineDelete', 'm1', 'r-older')

    expect(removed.ok).toBe(false)
    expect(r.stored().machines).toHaveLength(1)
    expect(capabilityEmits(r.harness)).toHaveLength(before)
    expect(capabilityEmits(r.harness).at(-1)?.state).toBe('ready')
  })
})

/* ------------------------------------------------------------------------ */
/* (3) snapshots() must never hand out a null overview                       */
/* ------------------------------------------------------------------------ */

/** Three saved machines, two of them swept - so `monitored` and `total` differ. */
const FLEET: BmcMachine[] = [
  machine(),
  machine({ id: 'm2', revision: 'r2', name: 'Rack B chassis', ip: '10.0.0.6' }),
  machine({ id: 'm3', revision: 'r3', name: 'Rack C chassis', ip: '10.0.0.7', enabled: false })
]

describe('snapshots(): what a freshly connected renderer is seeded with', () => {
  it('hands out an overview before the first sweep, counting the machines that will be swept', () => {
    const r = rig(FLEET)

    const snapshot = snapshotsOf(r.lifecycle)

    // summary.json gates on `overview.counts.monitored > 0`. A null here is
    // dropped by seedModuleSnapshots, the gate reads `undefined`, and the
    // widget says the fleet is empty for the whole of the first sweep.
    expect(snapshot.overview).not.toBeNull()
    const overview = snapshot.overview as OverviewPayload
    expect(overview.counts.monitored).toBe(2)
    expect(overview.counts.total).toBe(3)
  })

  it('hands out the same overview on the instance that never sweeps at all', () => {
    // Only the elected primary sweeps, so on every other connected machine
    // `overview.latest` stays null forever - not merely until the first sweep.
    const r = rig(FLEET, { isPrimaryInstance: false })
    r.lifecycle.applyPollers?.()

    const snapshot = snapshotsOf(r.lifecycle)

    expect(r.harness.exec).not.toHaveBeenCalled()
    expect(snapshot.overview).not.toBeNull()
    expect((snapshot.overview as OverviewPayload).counts.monitored).toBe(2)
  })

  it('hands out the published overview once a sweep has run, not a rebuilt one', async () => {
    const r = rig(FLEET)

    await r.lifecycle.refreshSlow?.(ID)

    const published = emitsOf<OverviewPayload>(r.harness, 'overview').at(-1)
    expect(published).toBeDefined()
    expect(snapshotsOf(r.lifecycle).overview).toBe(published)
  })

  it('fills every stream module.json declares, with nothing seedModuleSnapshots would drop', () => {
    const r = rig(FLEET)
    const declared = (manifest.streams ?? []).map((stream) => stream.event)

    const snapshot = snapshotsOf(r.lifecycle)

    expect(declared).toEqual(['machines', 'series', 'capabilities', 'overview', 'ui'])
    expect(Object.keys(snapshot).sort()).toEqual([...declared].sort())
    for (const event of declared) {
      // `== null` on purpose: that is the exact test the host applies before
      // it decides a stream has nothing to seed.
      expect(snapshot[event] == null, `${event} would be dropped as unset`).toBe(false)
    }
  })

  it('seeds an overview with the two fields the widget’s attention bindings read', () => {
    const r = rig(FLEET)

    const overview = snapshotsOf(r.lifecycle).overview as OverviewPayload

    // The seeded payload is a different code path from the published one
    // (`buildOverview(sweeper.snapshot())` rather than `overview.latest`), and
    // it is the one every freshly opened browser reads first. A field missing
    // only here would leave the widget still and correct-looking until the
    // next sweep replaced it.
    expect(typeof overview.healthLevel).toBe('number')
    expect(overview.machines.every((card) => typeof card.attention === 'boolean')).toBe(true)
  })
})

/* ------------------------------------------------------------------------ */
/* (4) the attention bindings resolve against the payload that is published  */
/* ------------------------------------------------------------------------ */

/**
 * ipmitool is installed here and no controller answers, so every swept machine
 * ends up `bad` - which is the only state that is supposed to move anything.
 */
function unreachableFleet(command: string): ModuleExecResult {
  if (command.includes('command -v ipmitool')) {
    return { stdout: 'ipmitool version 1.8.18\n', stderr: '', code: 0 }
  }
  return { stdout: '', stderr: 'Error: Unable to establish IPMI v2 / RMCP+ session\n', code: 1 }
}

/** One full sweep of FLEET, and the `overview` payload it actually emitted. */
async function sweptOverview(answer: (command: string) => ModuleExecResult): Promise<OverviewPayload> {
  const r = rig(FLEET, {}, answer)
  await r.lifecycle.refreshSlow?.(ID)
  const published = emitsOf<OverviewPayload>(r.harness, 'overview').at(-1)
  if (!published) throw new Error('the sweep published no overview at all')
  return published
}

/** A clause's dot-path may sit on its source or on itself; both resolve the same. */
function pathOf(clause: AttentionWhen): string | undefined {
  return (clause.source as { path?: string }).path ?? clause.path
}

/** `AttentionWhen` as the app evaluates it - the same three operators a conditional has. */
function resolves(clause: AttentionWhen, payload: unknown): boolean {
  const value = valueAt(payload, pathOf(clause))
  if (clause.op === 'exists') return value != null
  if (clause.op === 'eq') return value === clause.value
  return typeof value === 'number' && typeof clause.value === 'number' && value > clause.value
}

/**
 * The blink the module used to run itself.
 *
 * Until 0.6.0 this was a timer in `overview.ts` republishing the meter about
 * once a second so the bar would visibly jump. It is a spec clause now, which
 * is better in every way except one: a timer that stopped ticking was obvious,
 * and a binding that resolves to `undefined` is not. `attention` on a path the
 * payload does not carry renders a perfectly ordinary meter that never moves,
 * `attentionKey` naming a field no card has renders a perfectly ordinary wall,
 * and nothing anywhere reports either.
 *
 * So both are resolved here against the payload the sweep really emitted, and
 * against two fleets - one where nothing should move and one where something
 * must - because a clause wired to a constant would pass either test alone.
 */
describe('the widget’s attention bindings read fields the overview payload carries', () => {
  const meter = (): MeterBlock => onlyBlock(widget('summary'), 'meter')
  const wall = (): StatusCardsBlock => onlyBlock(widget('summary'), 'statusCards')

  it('points its meter, and the meter’s attention clause, at the overview stream', () => {
    const block = meter()

    expect(block.source).toMatchObject({ kind: 'stream', event: 'overview', path: 'meterValue' })
    expect(block.attention, 'the meter carries no attention clause').toBeDefined()
    expect(block.attention?.source).toMatchObject({ kind: 'stream', event: 'overview' })
    expect(pathOf(block.attention as AttentionWhen)).toBe('healthLevel')
  })

  it('names an attentionKey on the wall', () => {
    expect(wall().attentionKey).toBe('attention')
    expect(wall().source).toMatchObject({ kind: 'stream', event: 'overview', path: 'machines' })
  })

  it('resolves both against a swept fleet with nothing wrong, and asks for no movement', async () => {
    const overview = await sweptOverview(healthyFleet)
    const key = wall().attentionKey as string

    expect(valueAt(overview, 'meterValue')).toBe(0)
    expect(resolves(meter().attention as AttentionWhen, overview)).toBe(false)
    // Present and false, not absent: `attentionKey` reading `undefined` looks
    // exactly like this and is the bug the whole describe exists to catch.
    expect(overview.machines.length).toBeGreaterThan(0)
    for (const card of overview.machines) {
      expect(typeof valueAt(card, key), `${card.name} carries no "${key}"`).toBe('boolean')
      expect(valueAt(card, key), card.name).toBe(false)
    }
  })

  it('asks for movement on the fleet where every machine is unreachable', async () => {
    const overview = await sweptOverview(unreachableFleet)
    const key = wall().attentionKey as string

    expect(overview.healthLevel).toBe(2)
    expect(resolves(meter().attention as AttentionWhen, overview)).toBe(true)
    // The meter still says it standing still: `attention` is an enhancement,
    // and a reader who asked their system for less motion sees only the bar.
    expect(valueAt(overview, 'meterValue')).toBeGreaterThanOrEqual(90)
    expect(overview.machines.map((card) => valueAt(card, key))).toEqual(
      overview.machines.map(() => true)
    )
  })

  it('moves only the broken cards, not every card on a fleet with one fault', async () => {
    // A wall where a fault makes everything move says nothing about which card
    // to open, which is the failure mode `attentionKey` is per-card to avoid.
    const overview = await sweptOverview((command) =>
      command.includes("-H '10.0.0.5'") ? unreachableFleet(command) : healthyFleet(command)
    )
    const key = wall().attentionKey as string

    const moving = overview.machines.filter((card) => valueAt(card, key))
    expect(moving.map((card) => card.name)).toEqual(['Rack A chassis'])
    expect(overview.machines.length).toBeGreaterThan(moving.length)
  })
})
