import {
  createCheckSession,
  failedCheck,
  hasBlockingFinding,
  type ModuleCheckFinding,
  type ModuleCheckReport
} from '@shared/check'
import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import {
  DEFAULT_IPMI_PORT,
  makeMachineId,
  makeMachineRevision,
  machineFingerprint,
  type BmcMachine,
  type ConfigStore
} from './config'
import { runIpmi } from './ipmi'
import { parseMcInfo } from './parse'
import type { Queries } from './queries'
import { describeState, type Sweeper } from './sweep'

interface MachinePlan {
  machine: BmcMachine
  editing: string | null
  sourceRevision: string | null
  baseline: string | null
}

interface TestResult {
  revision: string
  at: number
  ok: boolean
  message: string
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

function address(machine: Pick<BmcMachine, 'ip' | 'port'>): string {
  return machine.port === DEFAULT_IPMI_PORT ? machine.ip : `${machine.ip}:${machine.port}`
}

function testLabel(result: TestResult | undefined): string {
  if (!result) return ''
  const date = new Date(result.at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${time} - ${result.ok ? 'OK' : 'Failed'}: ${result.message}`
}

export class MachineEditor {
  private session = createCheckSession<MachinePlan>()
  private tests = new Map<string, TestResult>()
  private generation = 0

  constructor(
    private ctx: ModuleContext,
    private store: ConfigStore,
    private sweeper: Sweeper,
    private queries: Queries
  ) {}

  /** Renderer-facing rows deliberately contain no password field. */
  rows(): Array<Record<string, unknown>> {
    return this.store.read().machines.map((machine) => {
      const runtime = this.sweeper.stateFor(machine.id, machine.revision)
      const presentation = describeState(runtime)
      const candidate = this.tests.get(machine.id)
      const tested = candidate?.revision === machine.revision ? candidate : undefined
      return {
        id: machine.id,
        revision: machine.revision,
        name: machine.name,
        ip: machine.ip,
        port: machine.port,
        username: machine.username,
        auth: machine.password ? 'password set' : 'password missing',
        note: machine.note ?? '',
        powerLabel: presentation.powerLabel,
        lastTest: testLabel(tested),
        problem: tested && !tested.ok ? tested.message : runtime?.lastError ?? ''
      }
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

    const findings: ModuleCheckFinding[] = []
    const name = text(values, 'name')
    const ip = text(values, 'ip')
    const username = text(values, 'username')
    const password = secret(values, 'password')
    const note = text(values, 'note')
    const portText = text(values, 'port')
    const port = portText === '' ? DEFAULT_IPMI_PORT : Number(portText)

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

    const keepingPassword = Boolean(existing?.password) && password === ''
    if (!password && !keepingPassword) {
      findings.push({ level: 'error', label: 'Enter the IPMI password' })
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
        label: `${address({ ip, port })} is already saved as "${duplicate.name}"`,
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
      password: password || (keepingPassword ? existing?.password ?? '' : ''),
      note: note || undefined
    }

    findings.unshift({
      level: 'pass',
      label: `${editingId ? 'Update' : 'Save'} ${machine.name} at ${address(machine)}`,
      detail: `IPMI 2.0 lanplus as ${machine.username}.`
    })
    findings.push({
      level: 'warning',
      label: 'This BMC password will be stored in clear text',
      detail:
        'It is written unencrypted in data/user-settings/module-config/bmc.json because modules cannot use the app secret service.'
    })

    if (!this.ctx.connected) {
      findings.push({
        level: 'warning',
        label: 'The credentials could not be tested',
        detail: 'Connect to a management machine, then use Test after saving.'
      })
    } else {
      const tested = await runIpmi(this.ctx, machine, 'mc info', 8_000)
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
          detail: tested.message ?? 'It can still be saved and tested later.'
        })
      }
    }

    if (generation !== this.generation) {
      return failedCheck('The connected management session changed', 'Check the form again.')
    }
    return {
      ok: true,
      token: this.session.issue(values, {
        machine,
        editing: editingId,
        sourceRevision: expectedRevision,
        baseline: existing ? machineFingerprint(existing) : null
      }),
      findings
    }
  }

  apply(editingId: string | null, expectedRevision: string | null, raw: unknown): OkResult {
    const payload = record(raw) as { token?: unknown; values?: unknown }
    const token = typeof payload.token === 'string' ? payload.token : ''
    const taken = this.session.take(token, payload.values)
    if (!taken) {
      return { ok: false, error: 'that check has expired or the form changed - check again' }
    }
    if (taken.payload.editing !== editingId) {
      return { ok: false, error: 'that check was for a different BMC machine' }
    }
    if (taken.payload.sourceRevision !== expectedRevision) {
      return { ok: false, error: 'that check was for a different BMC revision' }
    }

    const machine = taken.payload.machine
    const current = editingId
      ? this.store.read().machines.find((configured) => configured.id === editingId)
      : undefined
    if (editingId) {
      if (!current) return { ok: false, error: 'that BMC machine was removed - check again' }
      if (machineFingerprint(current) !== taken.payload.baseline) {
        return { ok: false, error: 'that BMC machine changed after the check - check again' }
      }
    } else if (
      this.store.read().machines.some((configured) => configured.id === machine.id)
    ) {
      return { ok: false, error: 'a machine with that generated id already exists - check again' }
    }

    this.store.update((config) => {
      const at = config.machines.findIndex((configured) => configured.id === machine.id)
      if (at >= 0) config.machines[at] = machine
      else config.machines.push(machine)
    })
    this.tests.delete(machine.id)
    this.queries.clearMachine(machine.id)
    this.sweeper.forgetMachine(machine.id)
    void this.sweeper.refreshOne(machine.id)
    this.ctx.log(`bmc: ${machine.name} (${address(machine)}) ${editingId ? 'updated' : 'added'}`)
    return { ok: true }
  }

  delete(idRaw: unknown, revisionRaw: unknown): OkResult {
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
    this.ctx.log(`bmc: ${removed.name} (${address(removed)}) deleted`)
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

    const fingerprint = machineFingerprint(machine)
    const result = await runIpmi(this.ctx, machine, 'mc info', 8_000)
    if (generation !== this.generation) {
      return { ok: false, error: 'the connected management session changed - test again' }
    }
    const current = this.store.read().machines.find((configured) => configured.id === id)
    if (!current || machineFingerprint(current) !== fingerprint) {
      return { ok: false, error: 'that BMC machine changed during the test - test again' }
    }
    if (!result.ok) {
      const message = result.message ?? 'connection test failed'
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
}
