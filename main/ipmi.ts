import type { ModuleContext } from '@shared/modules'
import { shQuote } from '@shared/shell'
import { IPMI_TIMEOUT_MS, type BmcMachine } from './config'
import { classifyIpmiFailure, type IpmiFailure } from './parse'

export interface IpmiResult {
  ok: boolean
  stdout: string
  failure?: IpmiFailure
  message?: string
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
  machine: BmcMachine,
  command: string,
  timeoutMs: number
): Promise<IpmiResult> {
  try {
    const result = await ctx.exec(command, { stdin: machine.password, timeoutMs })
    if (result.code === 0) return { ok: true, stdout: result.stdout }
    const message = resultMessage(result.stdout, result.stderr, result.code)
    return {
      ok: false,
      stdout: result.stdout,
      failure: classifyIpmiFailure(`${result.stderr}\n${result.stdout}`),
      message
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      stdout: '',
      failure: classifyIpmiFailure(message),
      message: message.replace(/\s+/g, ' ').slice(0, 500)
    }
  }
}

/**
 * Run one fixed ipmitool subcommand. The command line contains no credential:
 * stdin is read into an environment variable understood by `ipmitool -E`.
 */
export function runIpmi(
  ctx: ModuleContext,
  machine: BmcMachine,
  subcommand: string,
  timeoutMs = IPMI_TIMEOUT_MS
): Promise<IpmiResult> {
  const command = `IPMI_PASSWORD="$(cat)" ${baseCommand(machine)} ${subcommand}`
  return execute(ctx, machine, command, timeoutMs)
}

/**
 * Read standard controller, FRU, and LAN facts in one shell invocation. MC info
 * is the reachability/authentication gate; unsupported FRU or LAN reads are
 * allowed to leave their section empty.
 */
export function runIpmiInspect(
  ctx: ModuleContext,
  machine: BmcMachine,
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
  return execute(ctx, machine, command, timeoutMs)
}
