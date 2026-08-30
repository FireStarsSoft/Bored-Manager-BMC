/**
 * What the connected machine can do, as facts rather than as a verdict.
 *
 * The judgement lives in `runtime/readiness.ts`. Keeping them apart matters
 * for one reason: a probe that threw and a probe that answered "ipmitool is
 * not here" look identical if both are flattened into a `problem` string, and
 * only the first one is worth retrying.
 */
import type { ModuleContext } from '@shared/modules'

export interface BmcProbeFacts {
  t: number
  connected: boolean
  /** True once the probe has produced an answer, however unwelcome. */
  probed: boolean
  /** The version string, or an empty string when it is not installed. */
  ipmitool: string
  /** Set when the connected machine cannot run ipmitool at all. */
  problem: string | null
  /** Set when the probe itself failed, which is worth retrying rather than reporting as absence. */
  transportError: string | null
}

const MISSING_MESSAGE =
  'ipmitool is not installed on the connected machine - install it (apt install ipmitool / dnf install ipmitool) and press Look again'

const PROBE_COMMAND =
  'if command -v ipmitool >/dev/null 2>&1; then ipmitool -V 2>&1; else echo missing; fi'

export function unprobedFacts(connected = false): BmcProbeFacts {
  return {
    t: Date.now(),
    connected,
    probed: false,
    ipmitool: '',
    problem: null,
    transportError: null
  }
}

export async function probeManagementHost(ctx: ModuleContext): Promise<BmcProbeFacts> {
  if (!ctx.connected) return unprobedFacts(false)

  try {
    const result = await ctx.exec(PROBE_COMMAND, { timeoutMs: 15_000 })
    const firstLine = result.stdout.trim().split('\n')[0]?.trim() ?? ''
    if (firstLine === 'missing') {
      return {
        t: Date.now(),
        connected: true,
        probed: true,
        ipmitool: '',
        problem: MISSING_MESSAGE,
        transportError: null
      }
    }
    if (result.code !== 0 || !firstLine) {
      const detail = result.stderr.trim() || 'ipmitool did not report its version'
      return {
        t: Date.now(),
        connected: true,
        probed: true,
        ipmitool: '',
        problem: detail.replace(/\s+/g, ' ').slice(0, 300),
        transportError: null
      }
    }

    const version = firstLine.match(/\b(\d+\.\d+(?:\.\d+)*)\b/)?.[1] ?? firstLine
    return {
      t: Date.now(),
      connected: true,
      probed: true,
      ipmitool: version,
      problem: null,
      transportError: null
    }
  } catch (error) {
    // The command did not run. That is a connection that hiccupped, not a
    // machine without ipmitool, so `probed` stays false and readiness keeps
    // saying "checking" instead of accusing the host of missing a tool.
    const detail = error instanceof Error ? error.message : String(error)
    return {
      t: Date.now(),
      connected: true,
      probed: false,
      ipmitool: '',
      problem: null,
      transportError: detail.replace(/\s+/g, ' ').slice(0, 300)
    }
  }
}
