import type { ModuleContext } from '@shared/modules'
import { shQuote } from '@shared/shell'
import { IPMI_TIMEOUT_MS, type BmcMachine } from '../store'
import { classifyIpmiFailure, type IpmiFailure } from './classify'
import { failureMessage } from './messages'

export interface IpmiResult {
  ok: boolean
  stdout: string
  failure?: IpmiFailure
  /** ipmitool's own words, collapsed and truncated. */
  message?: string
  /** What that failure means, written for whoever has to fix it. */
  explanation?: string
}

function baseCommand(machine: BmcMachine): string {
  return [
    'ipmitool',
    '-I lanplus',
    `-H ${shQuote(machine.ip)}`,
    `-p ${shQuote(String(machine.port))}`,
    `-U ${shQuote(machine.username)}`,
    '-E',
    '-N 3',
    '-R 2'
  ].join(' ')
}

/** Keep renderer notices useful without handing them pages of tool output. */
function resultMessage(stdout: string, stderr: string, code: number): string {
  const raw = stderr.trim() || stdout.trim() || `ipmitool exited with code ${code}`
  return raw.replace(/\s+/g, ' ').slice(0, 500)
}

async function execute(
  ctx: ModuleContext,
  password: string,
  command: string,
  timeoutMs: number
): Promise<IpmiResult> {
  try {
    const result = await ctx.exec(command, { stdin: password, timeoutMs })
    if (result.code === 0) return { ok: true, stdout: result.stdout }
    const message = resultMessage(result.stdout, result.stderr, result.code)
    // The exit code carries what the text cannot: a command the app's own
    // timeout cut short prints nothing at all about why it stopped.
    const failure = classifyIpmiFailure(`${result.stderr}\n${result.stdout}`, result.code)
    return { ok: false, stdout: result.stdout, failure, message, explanation: failureMessage(failure) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const failure = classifyIpmiFailure(message)
    return {
      ok: false,
      stdout: '',
      failure,
      message: message.replace(/\s+/g, ' ').slice(0, 500),
      explanation: failureMessage(failure)
    }
  }
}

/**
 * Run one fixed ipmitool subcommand.
 *
 * The command line contains no credential: stdin is read into an environment
 * variable understood by `ipmitool -E`, so nothing sensitive is visible in the
 * target's process table. The password is passed in rather than read off the
 * machine, because it no longer lives on the machine - it is fetched from the
 * app's secret store at the point of use and dropped afterwards.
 */
export function runIpmi(
  ctx: ModuleContext,
  machine: BmcMachine,
  password: string,
  subcommand: string,
  timeoutMs = IPMI_TIMEOUT_MS
): Promise<IpmiResult> {
  const command = `IPMI_PASSWORD="$(cat)" ${baseCommand(machine)} ${subcommand}`
  return execute(ctx, password, command, timeoutMs)
}

/**
 * Read standard controller, FRU, and LAN facts in one shell invocation. MC info
 * is the reachability/authentication gate; unsupported FRU or LAN reads are
 * allowed to leave their section empty.
 */
export function runIpmiInspect(
  ctx: ModuleContext,
  machine: BmcMachine,
  password: string,
  timeoutMs: number
): Promise<IpmiResult> {
  const base = baseCommand(machine)
  const command = [
    'IPMI_PASSWORD="$(cat)"',
    'export IPMI_PASSWORD',
    `echo '===MC==='`,
    `${base} mc info`,
    '__bm_mc=$?',
    'if [ "$__bm_mc" -ne 0 ]; then exit "$__bm_mc"; fi',
    `echo '===FRU==='`,
    `${base} fru print || true`,
    `echo '===LAN==='`,
    `${base} lan print 1 || true`
  ].join('; ')
  return execute(ctx, password, command, timeoutMs)
}

/** The sentence to show for a failed result: what it means, then what it said. */
export function resultProblem(result: IpmiResult, fallback: string): string {
  const explanation = result.explanation ?? fallback
  return result.message ? `${explanation} (ipmitool said: ${result.message})` : explanation
}
