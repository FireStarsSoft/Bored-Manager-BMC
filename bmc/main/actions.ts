import type { ModuleContext } from '@shared/modules'
import type { ModuleTerminalCommand } from '@shared/module-ui'
import { shQuote } from '@shared/shell'
import type { OkResult } from '@shared/types'
import { resultProblem, runIpmi, type IpmiResult } from './ipmi'
import type { Queries } from './queries'
import { clampSetting, type BmcMachine, type ConfigStore, type Credentials } from './store'
import type { Sweeper } from './sweep'

const POWER_ACTIONS = ['on', 'soft', 'off', 'cycle', 'reset'] as const
const BOOT_DEVICES = ['none', 'pxe', 'disk', 'cdrom', 'bios'] as const

function isOneOf<T extends string>(value: string, choices: readonly T[]): value is T {
  return (choices as readonly string[]).includes(value)
}

/**
 * Everything that changes a machine rather than reading it.
 *
 * Each one names its subcommand from a fixed list. That is not defence
 * against the renderer - it is defence against a spec typo turning into an
 * arbitrary ipmitool invocation against somebody's hardware.
 */
export class Actions {
  constructor(
    private ctx: ModuleContext,
    private config: ConfigStore,
    private sweeper: Sweeper,
    private queries: Queries,
    private credentials: Credentials
  ) {}

  /**
   * Run one subcommand against a machine, fetching its password for exactly
   * that call. A credential that is missing or unreadable is reported as
   * itself rather than as a failed IPMI action - "enter the password again" is
   * something a user can act on, where "authentication failed" sends them
   * looking at the controller.
   */
  private async run(
    machine: BmcMachine,
    subcommand: string
  ): Promise<{ ok: true; result: IpmiResult } | { ok: false; error: string }> {
    const credential = await this.credentials.read(machine)
    if (!credential.password) {
      return { ok: false, error: credential.problem ?? 'This BMC has no usable password.' }
    }
    return { ok: true, result: await runIpmi(this.ctx, machine, credential.password, subcommand) }
  }

  async powerAction(
    idRaw: unknown,
    revisionRaw: unknown,
    actionRaw: unknown
  ): Promise<OkResult> {
    const machine = this.machine(idRaw, revisionRaw)
    if (!machine) return this.staleMachine()
    const action = String(actionRaw ?? '')
    if (!isOneOf(action, POWER_ACTIONS)) return { ok: false, error: 'unsupported power action' }

    const ran = await this.run(machine, `chassis power ${action}`)
    if (!ran.ok) return ran
    if (!ran.result.ok) {
      return { ok: false, error: resultProblem(ran.result, 'The power action failed.') }
    }
    await this.sweeper.refreshOne(machine.id)
    return { ok: true }
  }

  /**
   * The same power action against several machines at once.
   *
   * Called as `powerBulk(selectedIds, action)` - the ticked rows come first,
   * which is the shape a `bulkActions` button sends. There is no revision to
   * check against a selection, so each machine is resolved by id and a row
   * that changed underneath simply reports itself as skipped rather than
   * failing the whole batch: acting on nineteen of twenty machines and saying
   * which one was missed is more useful than refusing all twenty.
   *
   * Bounded by the same concurrency rule as a sweep, because this is the one
   * place a user can ask for sixty-four simultaneous ipmitool processes.
   */
  async powerBulk(idsRaw: unknown, actionRaw: unknown): Promise<OkResult> {
    const action = String(actionRaw ?? '')
    if (!isOneOf(action, POWER_ACTIONS)) return { ok: false, error: 'unsupported power action' }
    const ids = Array.isArray(idsRaw) ? idsRaw.map((id) => String(id)) : []
    if (ids.length === 0) return { ok: false, error: 'no machines were selected' }

    const configured = new Map(this.config.read().machines.map((entry) => [entry.id, entry]))
    const targets = ids
      .map((id) => configured.get(id))
      .filter((machine): machine is BmcMachine => Boolean(machine))
    const missing = ids.length - targets.length

    let done = 0
    const failures: string[] = []
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const machine = targets[cursor]
        cursor += 1
        const ran = await this.run(machine, `chassis power ${action}`)
        if (!ran.ok) failures.push(`${machine.name}: ${ran.error}`)
        else if (!ran.result.ok) {
          failures.push(`${machine.name}: ${resultProblem(ran.result, 'the power action failed')}`)
        } else done += 1
      }
    }
    const lanes = Math.max(1, Math.min(this.config.settings().sweepConcurrency, targets.length))
    await Promise.all(Array.from({ length: lanes }, () => worker()))

    void this.sweeper.run()

    const notes: string[] = []
    if (missing > 0) notes.push(`${missing} were no longer in the list`)
    if (failures.length > 0) notes.push(failures.slice(0, 5).join('; '))
    if (done === 0) {
      return { ok: false, error: notes.join(' - ') || 'nothing could be reached' }
    }
    const summary = `${action} sent to ${done} of ${ids.length} machines`
    return { ok: true, data: notes.length ? `${summary} - ${notes.join(' - ')}` : summary }
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
    const ran = await this.run(machine, `chassis bootdev ${device}${suffix}`)
    if (!ran.ok) return ran
    return ran.result.ok
      ? { ok: true }
      : { ok: false, error: resultProblem(ran.result, 'The boot-device override failed.') }
  }

  async identify(idRaw: unknown, revisionRaw: unknown, secondsRaw: unknown): Promise<OkResult> {
    const machine = this.machine(idRaw, revisionRaw)
    if (!machine) return this.staleMachine()
    // Anything unreadable falls back to the configured default, not the
    // module's shipped one: a user who set fifteen seconds to something else
    // meant it, and a typo in the prompt should not quietly ignore that.
    const entered = secondsRaw == null || secondsRaw === '' ? Number.NaN : Number(secondsRaw)
    const seconds = Number.isFinite(entered)
      ? clampSetting('identifySeconds', entered)
      : this.config.settings().identifySeconds
    const ran = await this.run(machine, `chassis identify ${seconds}`)
    if (!ran.ok) return ran
    return ran.result.ok
      ? { ok: true }
      : { ok: false, error: resultProblem(ran.result, 'The identify LED could not be set.') }
  }

  async selClear(idRaw: unknown, revisionRaw: unknown): Promise<OkResult> {
    const machine = this.machine(idRaw, revisionRaw)
    if (!machine) return this.staleMachine()
    const ran = await this.run(machine, 'sel clear')
    if (!ran.ok) return ran
    if (!ran.result.ok) {
      return { ok: false, error: resultProblem(ran.result, 'The event log could not be cleared.') }
    }
    this.queries.clearSel(machine.id)
    return { ok: true }
  }

  /**
   * The command line for a Serial-over-LAN session on one machine.
   *
   * Composed here, on the server, and handed straight to the terminal pool -
   * a `terminal` block's ordinary `commandTemplate` is built in the browser
   * from the spec and a row, which is fine for `docker exec` and impossible
   * for anything with a password in it. That is why this module had no SoL at
   * all until the app grew `commandMethod`.
   *
   * The password still never appears in a command line, on this machine or on
   * the target. It is written to a private temp file over `ctx.exec`'s stdin -
   * the same way every other ipmitool call here passes it - and the session
   * command names only the path, which is not a secret. The file is removed
   * when the session ends, and `mktemp` under `umask 077` means it is
   * unreadable by anybody else in between.
   */
  async solCommand(idRaw: unknown, revisionRaw: unknown): Promise<ModuleTerminalCommand> {
    const machine = this.machine(idRaw, revisionRaw)
    if (!machine) {
      return { command: '', problem: 'That BMC entry changed or was removed - reopen its card.' }
    }
    const credential = await this.credentials.read(machine)
    if (!credential.password) {
      return { command: '', problem: credential.problem ?? 'This BMC has no usable password.' }
    }

    const staged = await this.ctx.exec('umask 077; f=$(mktemp) && cat > "$f" && printf %s "$f"', {
      stdin: credential.password,
      timeoutMs: 10_000
    })
    const path = staged.code === 0 ? staged.stdout.trim() : ''
    if (!path.startsWith('/')) {
      return {
        command: '',
        problem:
          'The password could not be staged on the connected machine, so no session was opened.'
      }
    }

    const quoted = shQuote(path)
    return {
      command: [
        `ipmitool -I lanplus -H ${shQuote(machine.ip)} -p ${shQuote(String(machine.port))}`,
        `-U ${shQuote(machine.username)} -f ${quoted} sol activate`,
        // Whatever ends the session - the user typing the escape, the BMC
        // dropping it, the shell being closed - takes the file with it.
        `; rm -f ${quoted}`
      ].join(' ')
    }
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
