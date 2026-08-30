import { describe, expect, it, vi } from 'vitest'
import type { ModuleCheckReport } from '@shared/check'
import type { ModuleExecResult } from '@shared/modules'
import {
  moduleHarness,
  sharedModuleConfig,
  type ModuleHarnessOptions
} from '../helpers/module-harness'
import { MachineEditor } from '../../bmc/main/machines'
import { Queries } from '../../bmc/main/queries'
import {
  ConfigStore,
  Credentials,
  defaultSettings,
  MAX_MACHINES,
  type BmcConfig,
  type BmcMachine
} from '../../bmc/main/store'
import { Incidents, SeriesLog, Sweeper } from '../../bmc/main/sweep'

/**
 * The list of BMC endpoints, and the check/apply pair that edits it.
 *
 * Since 0.6.0 the password is not in this list at all. It lives in the app's
 * encrypted secret store under `machine/<id>`, and the settings document holds
 * only the things that are safe to write to a JSON file. Three invariants here
 * are worth more than the rest of the file put together.
 *
 * The password never reaches the renderer - a row says which *state* the
 * credential is in and nothing more. It travels from the browser exactly once,
 * inside the *check* payload, because the form field is `omitOnApply` and the
 * apply deliberately arrives blank. And it is written to the secret store
 * *before* the row is written to the document, so a store that refuses leaves
 * no machine behind: a saved machine with no password is a row that looks
 * perfectly fine and silently cannot authenticate.
 *
 * Losing any of the three is silent. The table still renders and the save still
 * says "ok" while the credential is on the wire, in a plain file, or gone.
 */

const MC_INFO = [
  'Device ID                 : 32',
  'Device Revision           : 1',
  'Firmware Revision         : 3.88',
  'IPMI Version              : 2.0',
  'Manufacturer ID           : 10876',
  'Manufacturer Name         : Supermicro',
  'Product ID                : 2050 (0x0802)',
  'Product Name              : X11DPU',
  'Device Available          : yes',
  'Provides Device SDRs      : no',
  ''
].join('\n')

/** A controller that answers everything the editor and the sweep ask of it. */
function healthyBmc(command: string): ModuleExecResult {
  if (command.includes('mc info')) return { stdout: MC_INFO, stderr: '', code: 0 }
  if (command.includes('chassis power status')) {
    return { stdout: 'Chassis Power is on\n', stderr: '', code: 0 }
  }
  return { stdout: '', stderr: '', code: 0 }
}

/** What ipmitool prints when the saved credentials are refused. */
function refusesCredentials(): ModuleExecResult {
  return {
    stdout: '',
    stderr: 'Error: Unable to establish IPMI v2 / RMCP+ session\n',
    code: 1
  }
}

/**
 * A machine as the settings document now holds one: no password field, because
 * `BmcMachine.password` exists only in a pre-version-3 document and is deleted
 * the moment the migration has moved its value into the secret store.
 */
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

function documentWith(machines: BmcMachine[]): BmcConfig {
  return { version: 3, machines, settings: defaultSettings(), hintsOn: true }
}

/** The values the check form posts; the renderer sends every field as typed. */
function formValues(over: Record<string, unknown> = {}): Record<string, unknown> {
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

/** The secret store key a machine's password is kept under. */
function keyFor(id: string): string {
  return `machine/${id}`
}

interface RigOptions {
  answer?: (command: string) => ModuleExecResult
  /** Passwords already in the store, keyed as the module keys them. */
  secrets?: Record<string, string>
  /** Keys that are stored but can no longer be decrypted by this install. */
  unreadableSecrets?: string[]
  storageGrant?: ModuleHarnessOptions['storageGrant']
}

/**
 * The editor with its real collaborators, wired as `createRuntime` wires them
 * (bmc/main/runtime/container.ts) minus the parts it does not touch - the
 * sweeper's readiness gate is answered "yes" here so an apply's refresh
 * behaves like it does on a connected machine.
 */
function rig(seed: BmcConfig, options: RigOptions = {}) {
  const config = sharedModuleConfig(seed)
  const harness = moduleHarness('bmc', options.answer ?? healthyBmc, {
    config,
    secrets: options.secrets,
    unreadableSecrets: options.unreadableSecrets,
    storageGrant: options.storageGrant
  })
  const store = new ConfigStore(harness.ctx)
  const credentials = new Credentials(harness.ctx)
  const sweeper = new Sweeper(
    harness.ctx,
    store,
    async () => true,
    new SeriesLog(harness.ctx),
    credentials,
    new Incidents(harness.ctx)
  )
  const editor = new MachineEditor(
    harness.ctx,
    store,
    sweeper,
    new Queries(harness.ctx, store, credentials),
    credentials
  )
  return {
    harness,
    store,
    editor,
    credentials,
    /** Watches every write to the secret store, so "kept" can be told from "rewritten". */
    secretSet: vi.spyOn(harness.ctx, 'secretSet'),
    /** The settings document as it now stands on "disk", not the store's cache. */
    stored: (): BmcMachine[] => (config.get() as BmcConfig).machines,
    /** The whole document, for assertions about what was written into the file. */
    document: (): unknown => config.get(),
    /** The password the app's encrypted store now holds for a machine. */
    saved: (id: string): Promise<string | null> => harness.ctx.secretGet(keyFor(id)),
    /** Every key the store holds, so a forgotten credential can be seen to be gone. */
    keys: async (): Promise<string[]> =>
      (await harness.ctx.secretList()).map((entry) => entry.key)
  }
}

function errorLabels(report: ModuleCheckReport): string[] {
  return report.findings.filter((finding) => finding.level === 'error').map((f) => f.label)
}

function finding(report: ModuleCheckReport, label: string) {
  return report.findings.find((f) => f.label === label)
}

/** The promise the check now makes, in place of the clear-text disclosure it used to make. */
const ENCRYPTION_PROMISE = 'The password will be encrypted'

describe('the BMC settings table rows', () => {
  it('carries the credential state rather than the credential, for all three states at once', async () => {
    // Three machines seeded three ways: one password readable, one stored but
    // undecryptable because this install's secret key is not the one it was
    // written with, one never entered. The column comes from `secretList` -
    // metadata only, no password is read to build a table.
    const { editor } = rig(
      documentWith([
        machine(),
        machine({ id: 'm2', revision: 'r2', name: 'Rack B', ip: '10.0.0.6' }),
        machine({ id: 'm3', revision: 'r3', name: 'Rack C', ip: '10.0.0.7' })
      ]),
      {
        secrets: { 'machine/m1': 'hunter2', 'machine/m2': 'was-readable-once' },
        unreadableSecrets: ['machine/m2']
      }
    )

    const rows = await editor.rows()

    // The central rule of this module's UI: the row is the whole contract with
    // the renderer, so the field must not exist rather than merely be blank.
    expect(Object.keys(rows[0])).not.toContain('password')
    expect(JSON.stringify(rows)).not.toContain('hunter2')
    expect(rows.map((row) => row.credential)).toEqual(['saved', 'unreadable', 'missing'])
    expect(rows.map((row) => row.auth)).toEqual([
      'password saved',
      'enter it again',
      'no password'
    ])
  })

  it('reads the credential state out of the store, not out of the settings document', async () => {
    // A document that still carries a legacy clear-text password says nothing
    // about whether this install can use it, and a document with none says
    // nothing about whether one is stored. Only the store knows.
    const { editor } = rig(
      documentWith([
        machine({ password: 'left-over-from-version-2' }),
        machine({ id: 'm2', revision: 'r2', name: 'Rack B', ip: '10.0.0.6' })
      ]),
      { secrets: { 'machine/m2': 'moved-already' } }
    )

    const rows = await editor.rows()

    expect(rows[0].credential).toBe('missing')
    expect(rows[1].credential).toBe('saved')
    expect(JSON.stringify(rows)).not.toContain('left-over-from-version-2')
  })

  it('reports the address, the enabled flag and the word for it, so the table need not re-derive them', async () => {
    const { editor } = rig(
      documentWith([
        machine({ port: 664 }),
        machine({ id: 'm2', revision: 'r2', name: 'Spare', ip: '10.0.0.6', enabled: false })
      ]),
      { secrets: { 'machine/m1': 'hunter2', 'machine/m2': 'hunter2' } }
    )

    const [swept, parked] = await editor.rows()

    expect(swept.address).toBe('10.0.0.5:664')
    expect(swept.enabled).toBe(true)
    expect(swept.enabledLabel).toBe('Swept')
    expect(parked.address).toBe('10.0.0.6')
    expect(parked.enabled).toBe(false)
    expect(parked.enabledLabel).toBe('Parked')
    expect(parked.powerLabel).toBe('Sweeping disabled')
  })

  it('reports the last test as a raw epoch number and a badge, never as a time this server formatted', async () => {
    const { editor } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'hunter2' }
    })
    expect((await editor.rows())[0].lastTestAt).toBeNull()
    expect((await editor.rows())[0].lastTestResult).toEqual([])

    const before = Date.now()
    const result = await editor.test('m1', 'r1')
    const after = Date.now()

    expect(result.ok).toBe(true)
    expect(result.data).toContain('Supermicro')
    const row = (await editor.rows())[0]
    // A string built here bakes in the server's timezone and reads as the
    // wrong hour to anybody elsewhere; the column formats the number instead.
    expect(typeof row.lastTestAt).toBe('number')
    expect(row.lastTestAt).toBeGreaterThanOrEqual(before)
    expect(row.lastTestAt).toBeLessThanOrEqual(after)
    expect(row.lastTestResult).toEqual([{ label: 'OK', color: '#22c55e' }])
    for (const value of Object.values(row)) {
      if (typeof value === 'string') expect(value).not.toMatch(/\d{1,2}:\d{2}/)
    }
  })

  it('shows a refused test as a Failed badge and puts ipmitool own words in the problem column', async () => {
    const { editor } = rig(documentWith([machine()]), {
      answer: refusesCredentials,
      secrets: { 'machine/m1': 'hunter2' }
    })

    const result = await editor.test('m1', 'r1')

    expect(result.ok).toBe(false)
    const row = (await editor.rows())[0]
    expect(typeof row.lastTestAt).toBe('number')
    expect(row.lastTestResult).toEqual([{ label: 'Failed', color: '#ef4444' }])
    expect(row.problem).toContain('ipmitool said')
  })

  it('answers a test on a machine with no usable credential as that, and asks the BMC nothing', async () => {
    // "Enter the password again" is something a user can act on. "The BMC
    // refused the saved credentials" - which is what testing with an empty
    // password would produce - sends them to the controller instead.
    const { editor, harness } = rig(
      documentWith([machine(), machine({ id: 'm2', revision: 'r2', ip: '10.0.0.6' })]),
      { secrets: { 'machine/m2': 'stored' }, unreadableSecrets: ['machine/m2'] }
    )

    const missing = await editor.test('m1', 'r1')
    const unreadable = await editor.test('m2', 'r2')

    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('No password is saved')
    expect(unreadable.ok).toBe(false)
    expect(unreadable.error).toContain('cannot be read')
    expect(unreadable.error).toContain('enter it again')
    expect(harness.exec).not.toHaveBeenCalled()
  })
})

describe('adding a machine: check, then apply', () => {
  it('issues a token the apply spends, writing the machine with a generated id and revision', async () => {
    const { editor, stored } = rig(documentWith([]))
    const values = formValues()

    const report = await editor.check(null, null, values)

    expect(report.ok).toBe(true)
    expect(typeof report.token).toBe('string')
    expect(report.findings[0]).toMatchObject({
      level: 'pass',
      label: 'Save Compute node 7 at 10.0.0.120'
    })

    expect(await editor.apply(null, null, { token: report.token, values })).toEqual({ ok: true })

    expect(stored()).toHaveLength(1)
    expect(stored()[0]).toMatchObject({
      name: 'Compute node 7',
      ip: '10.0.0.120',
      port: 623,
      username: 'operator',
      enabled: true
    })
    expect(stored()[0].id).toMatch(/^m/)
    expect(stored()[0].revision).toMatch(/^r/)
  })

  it('puts the password in the encrypted store and never in the settings document', async () => {
    // The whole point of 0.6.0 for this module. The document is a plain JSON
    // file a user can open; the store is encrypted with the install's key.
    const { editor, stored, document, saved, keys } = rig(documentWith([]))
    const values = formValues({ password: 'r4ck-adm1n' })

    const report = await editor.check(null, null, values)
    expect(await editor.apply(null, null, { token: report.token, values })).toEqual({ ok: true })

    const id = stored()[0].id
    expect(await saved(id)).toBe('r4ck-adm1n')
    expect(await keys()).toEqual([keyFor(id)])
    // Not merely blank in the document - absent from it, and absent from every
    // byte of the file the module writes.
    expect(Object.keys(stored()[0])).not.toContain('password')
    expect(stored()[0].password).toBeUndefined()
    expect(JSON.stringify(document())).not.toContain('r4ck-adm1n')
  })

  it('keeps the password the check captured when the apply sends the blank omitOnApply field', async () => {
    const { editor, stored, saved } = rig(documentWith([]))
    const checked = formValues({ password: 'hunter2' })

    const report = await editor.check(null, null, checked)
    // What the real renderer posts: `omitOnApply` blanks the password field
    // after the check froze it, so the secret crosses the wire exactly once.
    const applied = await editor.apply(null, null, {
      token: report.token,
      values: { ...checked, password: '' }
    })

    expect(applied).toEqual({ ok: true })
    // The blank that arrived on apply was ignored; the token's captured value
    // is what reached the store.
    expect(await saved(stored()[0].id)).toBe('hunter2')
  })

  it('promises the password will be encrypted, on an add and on an edit alike', async () => {
    const { editor } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'hunter2' }
    })

    const added = await editor.check(null, null, formValues())
    const edited = await editor.check('m1', 'r1', formValues({ ip: '10.0.0.5', password: '' }))

    // This replaced a standing clear-text warning, and it is a promise to the
    // user rather than a note: it has to hold every time, and nothing on the
    // report may still say the old thing.
    for (const report of [added, edited]) {
      expect(finding(report, ENCRYPTION_PROMISE)).toMatchObject({ level: 'pass' })
      expect(finding(report, ENCRYPTION_PROMISE)?.detail).toContain('secret store')
      expect(JSON.stringify(report.findings)).not.toContain('clear text')
    }
  })

  it('writes the credential before the row, so a store that refuses leaves no machine behind', async () => {
    // A saved machine with no password is the worst outcome available here: it
    // is a row that looks entirely fine and silently cannot authenticate, and
    // every sweep from then on hammers a controller with nothing.
    const { editor, stored, harness } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'hunter2' },
      // The store is already at its granted entry count, so the second
      // credential is refused the way a full store refuses one.
      storageGrant: { secrets: { requestedEntries: 1, grantedEntries: 1, valueBytes: 4096 } }
    })
    const values = formValues({ password: 'never-lands' })

    const report = await editor.check(null, null, values)
    expect(report.ok).toBe(true)
    const applied = await editor.apply(null, null, { token: report.token, values })

    expect(applied.ok).toBe(false)
    expect(applied.error).toContain('password could not be saved')
    expect(stored()).toHaveLength(1)
    expect(stored().map((entry) => entry.id)).toEqual(['m1'])
    expect(JSON.stringify(harness.ctx.configGet())).not.toContain('Compute node 7')
  })
})

describe('editing a machine', () => {
  it('leaves the stored password alone when the field is left blank, without rewriting it', async () => {
    const { editor, stored, saved, secretSet } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'hunter2' }
    })
    const values = formValues({ name: 'Rack A chassis (renamed)', ip: '10.0.0.5', password: '' })

    const report = await editor.check('m1', 'r1', values)
    expect(report.ok).toBe(true)
    expect(errorLabels(report)).toEqual([])
    expect(await editor.apply('m1', 'r1', { token: report.token, values })).toEqual({ ok: true })

    expect(await saved('m1')).toBe('hunter2')
    // "Keep it" means the store is not touched at all - not that the same
    // value is written back over itself.
    expect(secretSet).not.toHaveBeenCalled()
    expect(stored()[0].name).toBe('Rack A chassis (renamed)')
    expect(stored()[0].revision).not.toBe('r1')
  })

  it('replaces the stored password when a new one is typed', async () => {
    const { editor, stored, saved, secretSet } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'hunter2' }
    })
    // Sent unchanged on apply here so this test speaks only to which
    // credential is kept; the blanked-on-apply path has its own test above.
    const values = formValues({ ip: '10.0.0.5', password: 'rotated-2026' })

    const report = await editor.check('m1', 'r1', values)
    expect(await editor.apply('m1', 'r1', { token: report.token, values })).toEqual({ ok: true })

    expect(await saved('m1')).toBe('rotated-2026')
    expect(secretSet).toHaveBeenCalledWith('machine/m1', 'rotated-2026')
    expect(JSON.stringify(stored())).not.toContain('rotated-2026')
  })

  it('refuses a blank password when the stored one cannot be read, and says to enter it again', async () => {
    // The dangerous reading of "blank means keep it" is that a credential this
    // install can no longer decrypt counts as one to keep. It does not: there
    // is nothing to keep, and the check has to say so rather than saving a
    // machine whose every sweep will fail to authenticate.
    const { editor, harness } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'written-with-another-key' },
      unreadableSecrets: ['machine/m1']
    })

    const report = await editor.check('m1', 'r1', formValues({ ip: '10.0.0.5', password: '' }))

    expect(report.ok).toBe(false)
    expect(report.token).toBeUndefined()
    expect(errorLabels(report)).toEqual([
      'Enter the IPMI password again - the saved one can no longer be read'
    ])
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('accepts a freshly typed password for that same machine, which is the way out of it', async () => {
    const { editor, saved } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'written-with-another-key' },
      unreadableSecrets: ['machine/m1']
    })
    const values = formValues({ ip: '10.0.0.5', password: 'typed-again' })

    const report = await editor.check('m1', 'r1', values)
    expect(report.ok).toBe(true)
    expect(await editor.apply('m1', 'r1', { token: report.token, values })).toEqual({ ok: true })

    // The undecryptable entry is replaced rather than left beside a new one.
    expect(await saved('m1')).toBe('typed-again')
  })
})

describe('what a check refuses', () => {
  it('names every empty required field, issues no token, and asks the BMC nothing', async () => {
    const { editor, harness } = rig(documentWith([]))

    const report = await editor.check(null, null, {
      name: '',
      ip: '',
      port: '',
      username: '',
      password: '',
      enabled: true,
      note: ''
    })

    expect(report.ok).toBe(false)
    expect(report.token).toBeUndefined()
    expect(errorLabels(report)).toEqual([
      'Enter a machine name',
      'Enter the BMC address',
      'Enter an IPMI user name',
      'Enter the IPMI password'
    ])
    expect(harness.exec).not.toHaveBeenCalled()
  })

  it('refuses an address with a space or a character no host name can hold', async () => {
    const { editor } = rig(documentWith([]))

    const spaced = await editor.check(null, null, formValues({ ip: '10.0.0 120' }))
    const injected = await editor.check(null, null, formValues({ ip: '10.0.0.120; reboot' }))

    expect(spaced.ok).toBe(false)
    expect(errorLabels(spaced)).toContain('"10.0.0 120" is not a BMC address')
    expect(injected.ok).toBe(false)
    expect(errorLabels(injected)).toContain('"10.0.0.120; reboot" is not a BMC address')
  })

  it('refuses a port that is not a whole number a BMC could listen on', async () => {
    const { editor } = rig(documentWith([]))

    const tooHigh = await editor.check(null, null, formValues({ port: '70000' }))
    const notANumber = await editor.check(null, null, formValues({ port: 'six two three' }))

    expect(errorLabels(tooHigh)).toContain('Port 70000 is not valid')
    expect(tooHigh.token).toBeUndefined()
    expect(errorLabels(notANumber)).toContain('Port six two three is not valid')
    expect(notANumber.token).toBeUndefined()
  })

  it('warns, but does not block, when another entry already holds that address and port', async () => {
    const { editor } = rig(documentWith([machine()]))

    const report = await editor.check(null, null, formValues({ ip: '10.0.0.5', port: '623' }))

    expect(report.ok).toBe(true)
    expect(typeof report.token).toBe('string')
    expect(finding(report, '10.0.0.5 is already saved as "Rack A chassis"')).toMatchObject({
      level: 'warning'
    })
  })
})

describe('the ceiling on saved machines', () => {
  const full = (): BmcConfig =>
    documentWith(
      Array.from({ length: MAX_MACHINES }, (_, index) =>
        machine({
          id: `m${index}`,
          revision: `r${index}`,
          name: `Node ${index}`,
          ip: `10.0.1.${index}`
        })
      )
    )

  it('refuses a new machine once the list is full, and names the limit', async () => {
    const { editor } = rig(full())

    const report = await editor.check(null, null, formValues())

    expect(report.ok).toBe(false)
    expect(report.token).toBeUndefined()
    expect(report.findings[0].label).toContain(String(MAX_MACHINES))
  })

  it('still lets a machine already on the list be edited', async () => {
    const { editor, stored } = rig(full(), { secrets: { 'machine/m0': 'hunter2' } })
    const values = formValues({ name: 'Node 0 (renamed)', ip: '10.0.1.0', password: '' })

    const report = await editor.check('m0', 'r0', values)
    expect(report.ok).toBe(true)
    expect(await editor.apply('m0', 'r0', { token: report.token, values })).toEqual({ ok: true })

    expect(stored()).toHaveLength(MAX_MACHINES)
    expect(stored()[0].name).toBe('Node 0 (renamed)')
  })
})

describe('a row whose revision has moved on', () => {
  it('tells a check to reopen the row instead of editing what the user is no longer looking at', async () => {
    const { editor } = rig(documentWith([machine()]))

    const report = await editor.check('m1', 'r0-stale', formValues({ ip: '10.0.0.5' }))

    expect(report.ok).toBe(false)
    expect(report.findings[0]).toMatchObject({
      level: 'error',
      label: 'That BMC machine changed',
      detail: 'Close this drawer, open the latest row, and check again.'
    })
  })

  it('says plainly when the machine the form was opened on has been deleted', async () => {
    const { editor } = rig(documentWith([machine()]))

    const report = await editor.check('m-gone', 'r1', formValues())

    expect(report.ok).toBe(false)
    expect(report.findings[0].label).toBe('That BMC machine is gone')
  })

  it('refuses apply, delete, park and test alike, so no stale row can act on the current entry', async () => {
    const { editor, harness, stored, saved } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'hunter2' }
    })
    const values = formValues({ ip: '10.0.0.5', password: '' })
    const report = await editor.check('m1', 'r1', values)
    expect(report.ok).toBe(true)
    harness.exec.mockClear()

    const applied = await editor.apply('m1', 'r0-stale', { token: report.token, values })
    const deleted = await editor.delete('m1', 'r0-stale')
    const parked = editor.setEnabled('m1', 'r0-stale')
    const tested = await editor.test('m1', 'r0-stale')

    expect(applied).toEqual({ ok: false, error: 'that check was for a different BMC revision' })
    expect(deleted.ok).toBe(false)
    expect(deleted.error).toContain('changed')
    expect(parked.ok).toBe(false)
    expect(parked.error).toContain('changed')
    expect(tested).toEqual({ ok: false, error: 'that BMC machine changed - use the latest row' })
    // Nothing was written, no credential was put on the wire for a row that
    // describes a machine as it no longer is, and the stored one survived a
    // delete that was refused.
    expect(harness.exec).not.toHaveBeenCalled()
    expect(stored()[0]).toMatchObject({ revision: 'r1', name: 'Rack A chassis', enabled: true })
    expect(await saved('m1')).toBe('hunter2')
  })

  it('refuses an apply whose baseline no longer matches because the entry changed after the check', async () => {
    const { editor, store, stored } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'hunter2' }
    })
    const values = formValues({ ip: '10.0.0.5', password: '' })
    const report = await editor.check('m1', 'r1', values)

    // Another connected machine's instance renames it between the check the
    // user read and the save they pressed. The revision still matches, so only
    // the fingerprint catches this.
    store.update((config) => {
      config.machines[0].name = 'Renamed elsewhere'
    })

    const applied = await editor.apply('m1', 'r1', { token: report.token, values })

    expect(applied).toEqual({
      ok: false,
      error: 'that BMC machine changed after the check - check again'
    })
    expect(stored()[0].name).toBe('Renamed elsewhere')
  })
})

describe('parking and resuming one machine', () => {
  it('toggles sweeping, moves the revision so an in-flight reading is discarded, and keeps the credentials', async () => {
    const { editor, stored, saved } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'hunter2' }
    })

    const parked = editor.setEnabled('m1', 'r1')

    expect(parked).toEqual({ ok: true, data: 'Sweeping paused' })
    const after = stored()[0]
    expect(after.enabled).toBe(false)
    // The revision is what a sweep result is matched against, so parking has
    // to invalidate whatever is already in the air for this machine.
    expect(after.revision).not.toBe('r1')
    // A machine that is off for a fortnight should not have to be typed in
    // again, so parking leaves the credential exactly where it is.
    expect(await saved('m1')).toBe('hunter2')

    expect(editor.setEnabled('m1', after.revision)).toEqual({ ok: true, data: 'Sweeping resumed' })
    expect(stored()[0].enabled).toBe(true)
  })
})

describe('deleting a machine', () => {
  it('removes the entry, and only when the revision still matches', async () => {
    const { editor, stored } = rig(
      documentWith([machine(), machine({ id: 'm2', revision: 'r2', name: 'Rack B', ip: '10.0.0.6' })]),
      { secrets: { 'machine/m1': 'hunter2', 'machine/m2': 'hunter2' } }
    )

    expect((await editor.delete('m1', 'r-stale')).ok).toBe(false)
    expect(stored()).toHaveLength(2)

    expect(await editor.delete('m1', 'r1')).toEqual({ ok: true })

    expect(stored().map((entry) => entry.id)).toEqual(['m2'])
  })

  it('forgets the credential along with the row, and leaves the other machine its own', async () => {
    // A password left behind for a machine nobody can see is the worst kind of
    // leftover: nothing in the UI mentions it and nothing will ever use it.
    const { editor, saved, keys } = rig(
      documentWith([machine(), machine({ id: 'm2', revision: 'r2', name: 'Rack B', ip: '10.0.0.6' })]),
      { secrets: { 'machine/m1': 'hunter2', 'machine/m2': 'other-password' } }
    )

    expect(await editor.delete('m1', 'r1')).toEqual({ ok: true })

    expect(await saved('m1')).toBeNull()
    expect(await keys()).toEqual([keyFor('m2')])
    expect(await saved('m2')).toBe('other-password')
  })

  it('keeps the credential when the delete was refused, because the row is still there', async () => {
    const { editor, saved, keys } = rig(documentWith([machine()]), {
      secrets: { 'machine/m1': 'hunter2' }
    })

    expect((await editor.delete('m1', 'r-stale')).ok).toBe(false)

    expect(await saved('m1')).toBe('hunter2')
    expect(await keys()).toEqual([keyFor('m1')])
  })
})
