import type { ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import type { BmcMachine, ConfigStore } from './config'
import { runIpmi } from './ipmi'
import type { Queries } from './queries'
import type { Sweeper } from './sweep'

const POWER_ACTIONS = ['on', 'soft', 'off', 'cycle', 'reset'] as const
const BOOT_DEVICES = ['none', 'pxe', 'disk', 'cdrom', 'bios'] as const

function isOneOf<T extends string>(value: string, choices: readonly T[]): value is T {
  return (choices as readonly string[]).includes(value)
}

export class Actions {
  constructor(
    private ctx: ModuleContext,
    private config: ConfigStore,
    private sweeper: Sweeper,
    private queries: Queries
  ) {}

  async powerAction(
    idRaw: unknown,
    revisionRaw: unknown,
    actionRaw: unknown
  ): Promise<OkResult> {
    const machine = this.machine(idRaw, revisionRaw)
    if (!machine) return this.staleMachine()
    const action = String(actionRaw ?? '')
    if (!isOneOf(action, POWER_ACTIONS)) return { ok: false, error: 'unsupported power action' }

    const result = await runIpmi(this.ctx, machine, `chassis power ${action}`)
    if (!result.ok) return { ok: false, error: result.message ?? 'power action failed' }
    await this.sweeper.refreshOne(machine.id)
    return { ok: true }
  }

  async bootDevSet(
    idRaw: unknown,
    revisionRaw: unknown,
    deviceRaw: unknown,
    persistentRaw: unknown
  ): Promise<OkResult> {
    const machine = this.machine(idRaw, revisionRaw)
    if (!machine) return this.staleMachine()
    const device = String(deviceRaw ?? '')
    if (!isOneOf(device, BOOT_DEVICES)) return { ok: false, error: 'unsupported boot device' }

    const persistent = persistentRaw === true
    const suffix = persistent ? ' options=persistent' : ''
    const result = await runIpmi(this.ctx, machine, `chassis bootdev ${device}${suffix}`)
    return result.ok
      ? { ok: true }
      : { ok: false, error: result.message ?? 'boot-device action failed' }
  }

  async identify(idRaw: unknown, revisionRaw: unknown, secondsRaw: unknown): Promise<OkResult> {
    const machine = this.machine(idRaw, revisionRaw)
    if (!machine) return this.staleMachine()
    const entered = secondsRaw == null || secondsRaw === '' ? 15 : Number(secondsRaw)
    const seconds = Number.isFinite(entered) ? Math.max(0, Math.min(255, Math.trunc(entered))) : 15
    const result = await runIpmi(this.ctx, machine, `chassis identify ${seconds}`)
    return result.ok ? { ok: true } : { ok: false, error: result.message ?? 'identify action failed' }
  }

  async selClear(idRaw: unknown, revisionRaw: unknown): Promise<OkResult> {
    const machine = this.machine(idRaw, revisionRaw)
    if (!machine) return this.staleMachine()
    const result = await runIpmi(this.ctx, machine, 'sel clear')
    if (!result.ok) return { ok: false, error: result.message ?? 'event-log clear failed' }
    this.queries.clearSel(machine.id)
    return { ok: true }
  }

  private machine(idRaw: unknown, revisionRaw: unknown): BmcMachine | undefined {
    const id = String(idRaw ?? '')
    const revision = String(revisionRaw ?? '')
    const machine = this.config.read().machines.find((entry) => entry.id === id)
    if (!machine || machine.revision !== revision) {
      this.sweeper.forgetMachine(id)
      return undefined
    }
    return machine
  }

  private staleMachine(): OkResult {
    return {
      ok: false,
      error: 'that BMC machine changed or was removed - reopen its card and try again'
    }
  }
}
