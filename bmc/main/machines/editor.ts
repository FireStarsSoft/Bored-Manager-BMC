import {
  createCheckSession,
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { parseMcInfo, resultProblem, runIpmi } from '../ipmi'
import type { Queries } from '../queries'
import {
  DEFAULT_IPMI_PORT,
  MAX_MACHINES,
  machineAddress,
  machineFingerprint,
  makeMachineId,
  makeMachineRevision,
  TEST_TIMEOUT_MS,
  type BmcMachine,
  type ConfigStore,
  type Credentials
} from '../store'
import { describeState, type Sweeper } from '../sweep'
import { buildRow, type MachineRow, type TestResult } from './rows'

interface MachinePlan {
  machine: BmcMachine
  /**
   * The password to store on apply, or null to leave whatever is already in
   * the secret store alone. It rides in the token rather than on the machine
   * because a machine is a settings document row and this is not: it goes
   * straight from here to `ctx.secretSet` and nowhere else.
   */
  password: string | null
  editing: string | null
  sourceRevision: string | null
  baseline: string | null
}

function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

function text(values: Record<string, unknown>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim()
}

function secret(values: Record<string, unknown>, key: string): string {
  const value = values[key]
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

/**
 * The form as the apply will send it.
 *
 * The password field is `omitOnApply`, so the renderer blanks it once the
 * check has frozen it - which means the values that reach `apply` can never
 * equal the ones that were checked, and `createCheckSession` compares them
 * exactly. Dropping the key on both sides is what makes the token match: every
 * other field is still compared, so re-pointing the address between check and
 * apply is still caught, and the credential itself is carried by the token's
 * payload rather than by the wire.
 */
function applyShape(values: Record<string, unknown>): Record<string, unknown> {
  const { password: _password, ...rest } = values
  return rest
}

/**
 * Adding and editing a BMC entry, through a check the user reads before an
 * apply they authorise.
 *
 * The token the check issues carries the fully built machine and, separately,
 * the password to store. That is what lets the form's password field be
 * `omitOnApply`: the secret crosses the wire once, during the check, and the
 * apply sends an empty value that this deliberately ignores.
 *
 * The password never reaches the settings document. It goes from the token to
 * `ctx.secretSet` and nowhere else, and every later use fetches it back one
 * call at a time.
 */
export class MachineEditor {
  private session = createCheckSession<MachinePlan>()
  private tests = new Map<string, TestResult>()
  private generation = 0

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore,
    private sweeper: Sweeper,
    private queries: Queries,
    private credentials: Credentials
  ) {}

  async rows(): Promise<MachineRow[]> {
    // One call for the whole fleet, and it answers with names and metadata
    // rather than values - so the table can say "saved" or "enter it again"
    // per row without a password being read at all.
    const states = await this.credentials.states()
    return this.store.read().machines.map((machine) => {
      const runtime = this.sweeper.stateFor(machine.id, machine.revision)
      const presentation = describeState(runtime, machine.enabled)
      const candidate = this.tests.get(machine.id)
      const tested = candidate?.revision === machine.revision ? candidate : undefined
      return buildRow(machine, runtime, presentation, tested, states.get(machine.id) ?? 'missing')
    })
  }

  async check(
    editingId: string | null,
    expectedRevision: string | null,
    raw: unknown
  ): Promise<ModuleCheckReport> {
    const generation = this.generation
    const values = record(raw)
    const config = this.store.read()
    const existing = editingId
      ? config.machines.find((machine) => machine.id === editingId)
      : undefined
    if (editingId && !existing) {
      return failedCheck(
        'That BMC machine is gone',
        'Somebody removed it while this form was open.'
      )
    }
    if (existing && existing.revision !== expectedRevision) {
      return failedCheck(
        'That BMC machine changed',
        'Close this drawer, open the latest row, and check again.'
      )
    }
    if (!editingId && config.machines.length >= MAX_MACHINES) {
      return failedCheck(
        `This module keeps at most ${MAX_MACHINES} BMC machines`,
        'Delete an entry you no longer use, or park it and delete another - every saved machine costs one ipmitool call per sweep.'
      )
    }

    const findings: ModuleCheckFinding[] = []
    const name = text(values, 'name')
    const ip = text(values, 'ip')
    const username = text(values, 'username')
    const password = secret(values, 'password')
    const note = text(values, 'note')
    const portText = text(values, 'port')
    const port = portText === '' ? DEFAULT_IPMI_PORT : Number(portText)
    // Absent means the field was not on this form; only an explicit false parks.
    const enabled = values.enabled === undefined ? existing?.enabled ?? true : values.enabled !== false

    if (!name) findings.push({ level: 'error', label: 'Enter a machine name' })
    if (!ip) {
      findings.push({ level: 'error', label: 'Enter the BMC address' })
    } else if (!/^[A-Za-z0-9._-]+$/.test(ip)) {
      findings.push({
        level: 'error',
        label: `"${ip}" is not a BMC address`,
        detail: 'Use an IPv4 address or a DNS host name without spaces.'
      })
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      findings.push({ level: 'error', label: `Port ${portText || '(empty)'} is not valid` })
    }
    if (!username) findings.push({ level: 'error', label: 'Enter an IPMI user name' })

    // A blank field on an edit means "keep what is stored", so what counts is
    // whether anything readable IS stored - not whether the document carries a
    // password, which it no longer does.
    const storedState = existing ? (await this.credentials.states()).get(existing.id) : undefined
    const keepingPassword = password === '' && storedState === 'saved'
    if (!password && !keepingPassword) {
      findings.push({
        level: 'error',
        label:
          storedState === 'unreadable'
            ? 'Enter the IPMI password again - the saved one can no longer be read'
            : 'Enter the IPMI password'
      })
    }

    const duplicate = config.machines.find(
      (machine) =>
        machine.id !== editingId &&
        machine.ip.toLowerCase() === ip.toLowerCase() &&
        machine.port === port
    )
    if (duplicate) {
      findings.push({
        level: 'warning',
        label: `${machineAddress({ ip, port })} is already saved as "${duplicate.name}"`,
        detail: 'Both entries will be polled and may show the same controller twice.'
      })
    }

    if (hasBlockingFinding(findings)) return { ok: false, findings }

    const machine: BmcMachine = {
      id:
        existing?.id ??
        makeMachineId(new Set(config.machines.map((configured) => configured.id))),
      revision: makeMachineRevision(),
      name,
      ip,
      port,
      username,
      enabled,
      note: note || undefined
    }

    // Read back only when the form left it blank and something is stored, so
    // the connection test below tries the credential that will actually be
    // used. It is held for this call and never written to the document.
    const effective =
      password || (keepingPassword ? ((await this.credentials.read(machine)).password ?? '') : '')

    findings.unshift({
      level: 'pass',
      label: `${editingId ? 'Update' : 'Save'} ${machine.name} at ${machineAddress(machine)}`,
      detail: `IPMI 2.0 lanplus as ${machine.username}.`
    })
    if (!machine.enabled) {
      findings.push({
        level: 'warning',
        label: 'This machine will not be swept',
        detail: 'It keeps its credentials and its row, and nothing is asked of it until you switch sweeping back on.'
      })
    }
    findings.push({
      level: 'pass',
      label: 'The password will be encrypted',
      detail:
        "It is kept in the app's own secret store, encrypted with this install's key, and never written into this module's settings file."
    })

    if (!this.ctx.connected) {
      findings.push({
        level: 'warning',
        label: 'The credentials could not be tested',
        detail: 'Connect to a management machine, then use Test after saving.'
      })
    } else {
      const tested = await runIpmi(this.ctx, machine, effective, 'mc info', TEST_TIMEOUT_MS)
      if (tested.ok) {
        const info = parseMcInfo(tested.stdout)
        const identity = [info.manufacturer, info.product].filter(Boolean).join(' ')
        findings.push({
          level: 'pass',
          label: identity ? `${identity} answered` : 'The BMC answered',
          detail: info.firmware ? `Firmware ${info.firmware}.` : undefined
        })
      } else {
        findings.push({
          level: 'warning',
          label: 'The BMC did not pass the connection test',
          detail: resultProblem(tested, 'It can still be saved and tested later.')
        })
      }
    }

    if (generation !== this.generation) {
      return failedCheck('The connected management session changed', 'Check the form again.')
    }
    return {
      ok: true,
      token: this.session.issue(applyShape(values), {
        machine,
        // Null means "leave the stored one alone", which is what a blank field
        // on an edit asks for.
        password: password || null,
        editing: editingId,
        sourceRevision: expectedRevision,
        baseline: existing ? machineFingerprint(existing) : null
      }),
      findings
    }
  }

  async apply(
    editingId: string | null,
    expectedRevision: string | null,
    raw: unknown
  ): Promise<OkResult> {
    const payload = record(raw) as { token?: unknown; values?: unknown }
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, applyShape(record(payload.values)))
    if (!taken) {
      return { ok: false, error: 'that check has expired or the form changed - check again' }
    }
    if (taken.payload.editing !== editingId) {
      return { ok: false, error: 'that check was for a different BMC machine' }
    }
    if (taken.payload.sourceRevision !== expectedRevision) {
      return { ok: false, error: 'that check was for a different BMC revision' }
    }

    // The machine comes from the token, never from `payload.values` - the
    // password field is `omitOnApply`, so what arrives here is deliberately
    // blank and using it would wipe the credential the check just verified.
    const machine = taken.payload.machine
    const password = taken.payload.password
    const current = editingId
      ? this.store.read().machines.find((configured) => configured.id === editingId)
      : undefined
    if (editingId) {
      if (!current) return { ok: false, error: 'that BMC machine was removed - check again' }
      if (machineFingerprint(current) !== taken.payload.baseline) {
        return { ok: false, error: 'that BMC machine changed after the check - check again' }
      }
    } else {
      const config = this.store.read()
      if (config.machines.some((configured) => configured.id === machine.id)) {
        return { ok: false, error: 'a machine with that generated id already exists - check again' }
      }
      if (config.machines.length >= MAX_MACHINES) {
        return { ok: false, error: `this module keeps at most ${MAX_MACHINES} BMC machines` }
      }
    }

    // The credential goes first. If the store refuses it, nothing has been
    // written and the user is told the save failed - where the other order
    // would leave a saved machine with no password, which reads as a working
    // entry that silently fails to authenticate.
    if (password !== null) {
      try {
        await this.credentials.write(machine.id, password)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        return { ok: false, error: `the password could not be saved - ${detail}` }
      }
    }

    this.store.update((config) => {
      const at = config.machines.findIndex((configured) => configured.id === machine.id)
      if (at >= 0) config.machines[at] = machine
      else config.machines.push(machine)
    })
    this.afterWrite(machine.id)
    this.ctx.log(
      `bmc: ${machine.name} (${machineAddress(machine)}) ${editingId ? 'updated' : 'added'}`
    )
    return { ok: true }
  }

  /**
   * Park or resume one machine.
   *
   * The revision moves, because parking changes what the sweep is allowed to
   * do with this entry and any reading already in the air belongs to the old
   * answer.
   */
  setEnabled(idRaw: unknown, revisionRaw: unknown): OkResult {
    const id = String(idRaw ?? '')
    const revision = String(revisionRaw ?? '')
    let changed: BmcMachine | undefined
    this.store.update((config) => {
      const at = config.machines.findIndex((machine) => machine.id === id)
      if (at < 0) return
      if (config.machines[at].revision !== revision) return
      const machine = config.machines[at]
      machine.enabled = !machine.enabled
      machine.revision = makeMachineRevision()
      changed = machine
    })
    if (!changed) return { ok: false, error: 'that BMC machine changed or no longer exists' }

    this.afterWrite(changed.id)
    this.ctx.log(
      `bmc: ${changed.name} (${machineAddress(changed)}) ${changed.enabled ? 'resumed' : 'parked'}`
    )
    return { ok: true, data: changed.enabled ? 'Sweeping resumed' : 'Sweeping paused' }
  }

  async delete(idRaw: unknown, revisionRaw: unknown): Promise<OkResult> {
    const id = String(idRaw ?? '')
    const revision = String(revisionRaw ?? '')
    let removed: BmcMachine | undefined
    this.store.update((config) => {
      const at = config.machines.findIndex((machine) => machine.id === id)
      if (at < 0) return
      if (config.machines[at].revision !== revision) return
      removed = config.machines[at]
      config.machines.splice(at, 1)
    })
    if (!removed) return { ok: false, error: 'that BMC machine changed or no longer exists' }

    this.session.clear()
    this.tests.delete(id)
    this.queries.clearMachine(id)
    this.sweeper.forgetMachine(id)
    // The row and its password go together. Leaving the credential behind
    // would fill the store with secrets for machines nobody can see.
    await this.credentials.forget(id)
    this.ctx.log(`bmc: ${removed.name} (${machineAddress(removed)}) deleted`)
    return { ok: true }
  }

  async test(idRaw: unknown, revisionRaw: unknown): Promise<OkResult> {
    const generation = this.generation
    const id = String(idRaw ?? '')
    const revision = String(revisionRaw ?? '')
    const machine = this.store.read().machines.find((configured) => configured.id === id)
    if (!machine) return { ok: false, error: 'no such BMC machine' }
    if (machine.revision !== revision) {
      return { ok: false, error: 'that BMC machine changed - use the latest row' }
    }
    if (!this.ctx.connected) return { ok: false, error: 'not connected to a management machine' }

    const credential = await this.credentials.read(machine)
    if (!credential.password) {
      return { ok: false, error: credential.problem ?? 'This BMC has no usable password.' }
    }

    const fingerprint = machineFingerprint(machine)
    const result = await runIpmi(
      this.ctx,
      machine,
      credential.password,
      'mc info',
      TEST_TIMEOUT_MS
    )
    if (generation !== this.generation) {
      return { ok: false, error: 'the connected management session changed - test again' }
    }
    const current = this.store.read().machines.find((configured) => configured.id === id)
    if (!current || machineFingerprint(current) !== fingerprint) {
      return { ok: false, error: 'that BMC machine changed during the test - test again' }
    }
    if (!result.ok) {
      const message = resultProblem(result, 'The connection test failed.')
      this.tests.set(id, { revision: machine.revision, at: Date.now(), ok: false, message })
      return { ok: false, error: message }
    }

    const info = parseMcInfo(result.stdout)
    const identity = [info.manufacturer, info.product].filter(Boolean).join(' ')
    const message = [identity || 'BMC answered', info.firmware ? `firmware ${info.firmware}` : '']
      .filter(Boolean)
      .join(', ')
    this.tests.set(id, { revision: machine.revision, at: Date.now(), ok: true, message })
    return { ok: true, data: message }
  }

  clear(): void {
    this.generation += 1
    this.session.clear()
    this.tests.clear()
  }

  private afterWrite(id: string): void {
    this.tests.delete(id)
    this.queries.clearMachine(id)
    this.sweeper.forgetMachine(id)
    void this.sweeper.refreshOne(id)
  }
}
