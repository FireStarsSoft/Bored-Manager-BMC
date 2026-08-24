import type { ModuleContext } from '@shared/modules'

export interface BmcCapabilities {
  t: number
  connected: boolean
  ipmitool: string
  problem: string | null
}

const MISSING_MESSAGE =
  'ipmitool is not installed on the connected machine - install it (apt install ipmitool / dnf install ipmitool) and press Look again'

const PROBE_COMMAND =
  'if command -v ipmitool >/dev/null 2>&1; then ipmitool -V 2>&1; else echo missing; fi'

export function emptyCapabilities(): BmcCapabilities {
  return {
    t: Date.now(),
    connected: false,
    ipmitool: 'missing',
    problem: 'Not connected to a machine yet.'
  }
}

export async function probeManagementHost(ctx: ModuleContext): Promise<BmcCapabilities> {
  if (!ctx.connected) return emptyCapabilities()

  try {
    const result = await ctx.exec(PROBE_COMMAND, { timeoutMs: 15_000 })
    const firstLine = result.stdout.trim().split('\n')[0]?.trim() ?? ''
    if (firstLine === 'missing') {
      return { t: Date.now(), connected: true, ipmitool: 'missing', problem: MISSING_MESSAGE }
    }
    if (result.code !== 0 || !firstLine) {
      const detail = result.stderr.trim() || 'ipmitool did not report its version'
      return {
        t: Date.now(),
        connected: true,
        ipmitool: 'missing',
        problem: detail.replace(/\s+/g, ' ').slice(0, 300)
      }
    }

    const version = firstLine.match(/\b(\d+\.\d+(?:\.\d+)*)\b/)?.[1] ?? firstLine
    return { t: Date.now(), connected: true, ipmitool: version, problem: null }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      t: Date.now(),
      connected: true,
      ipmitool: 'missing',
      problem: detail.replace(/\s+/g, ' ').slice(0, 300)
    }
  }
}
