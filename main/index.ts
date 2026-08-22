/**
 * BMC management through `ipmitool` on the machine Bored Manager is connected
 * to. Network polling is slow and bounded; renderer invoke sources either read
 * memory or use short-lived query caches.
 */
import type { ModuleActivate, ModuleContext } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { Actions } from './actions'
import { ConfigStore } from './config'
import { MachineEditor } from './machines'
import {
  emptyCapabilities,
  probeManagementHost,
  type BmcCapabilities
} from './probe'
import { Queries } from './queries'
import { Sweeper } from './sweep'

const INTERVAL_KEY = 'bmc'

const activate: ModuleActivate = (ctx: ModuleContext) => {
  const config = new ConfigStore(ctx)
  let capabilities: BmcCapabilities = emptyCapabilities()
  let capabilityFlight: Promise<BmcCapabilities> | null = null
  let capabilityGeneration = 0
  let stopped = false

  const refreshCapabilities = (force = false): Promise<BmcCapabilities> => {
    if (!force && capabilities.connected) return Promise.resolve(capabilities)
    if (capabilityFlight) return capabilityFlight

    const generation = capabilityGeneration
    const pending = probeManagementHost(ctx)
      .then((next) => {
        if (stopped || generation !== capabilityGeneration) return next
        capabilities = next
        ctx.emit('capabilities', capabilities)
        if (capabilities.problem) ctx.log(`bmc: ${capabilities.problem}`)
        return next
      })
      .finally(() => {
        if (capabilityFlight === pending) capabilityFlight = null
      })
    capabilityFlight = pending
    return pending
  }

  const sweeper = new Sweeper(ctx, config, () => refreshCapabilities(false))
  const queries = new Queries(ctx, config)
  const actions = new Actions(ctx, config, sweeper, queries)
  const machines = new MachineEditor(ctx, config, sweeper, queries)

  ctx.handle('machineRows', () => machines.rows())
  ctx.handle('machineCheck', (...args: unknown[]) =>
    args.length >= 3
      ? machines.check(String(args[0]), String(args[1]), args[2])
      : machines.check(null, null, args[0])
  )
  ctx.handle('machineApply', (...args: unknown[]) =>
    args.length >= 3
      ? machines.apply(String(args[0]), String(args[1]), args[2])
      : machines.apply(null, null, args[0])
  )
  ctx.handle('machineDelete', (id: unknown, revision: unknown) =>
    machines.delete(id, revision)
  )
  ctx.handle('machineTest', (id: unknown, revision: unknown) =>
    machines.test(id, revision)
  )
  ctx.handle('machineInspect', (id: unknown, revision: unknown) =>
    queries.machineInspect(id, revision)
  )
  ctx.handle('powerAction', (id: unknown, revision: unknown, action: unknown) =>
    actions.powerAction(id, revision, action)
  )
  ctx.handle('sensorRows', (id: unknown, revision: unknown) =>
    queries.sensorRows(id, revision)
  )
  ctx.handle('selRows', (id: unknown, revision: unknown) =>
    queries.selRows(id, revision)
  )
  ctx.handle('selClear', (id: unknown, revision: unknown) =>
    actions.selClear(id, revision)
  )
  ctx.handle(
    'bootDevSet',
    (id: unknown, revision: unknown, device: unknown, persistent: unknown) =>
      actions.bootDevSet(id, revision, device, persistent)
  )
  ctx.handle('identify', (id: unknown, revision: unknown, seconds: unknown) =>
    actions.identify(id, revision, seconds)
  )
  ctx.handle('sweepNow', async (): Promise<OkResult> => {
    if (!ctx.connected) return { ok: false, error: 'not connected to a management machine' }
    const available = await refreshCapabilities(true)
    if (available.problem) return { ok: false, error: available.problem }
    await sweeper.run()
    return { ok: true }
  })

  let applied: string | null = null

  return {
    applyPollers() {
      const seconds = Math.max(0, ctx.slowIntervalSec(INTERVAL_KEY))
      const key = `${ctx.connected}|${seconds}`
      if (key === applied) return
      applied = key
      sweeper.poller.stop()
      if (!ctx.connected) return

      void refreshCapabilities(true).then(() => {
        if (stopped || !ctx.connected || applied !== key) return
        if (seconds > 0) sweeper.poller.start(seconds * 1000)
        else void sweeper.run()
      })
    },

    reset() {
      applied = null
      capabilityGeneration += 1
      capabilityFlight = null
      capabilities = emptyCapabilities()
      sweeper.reset()
      queries.reset()
      machines.clear()
      config.reset()
    },

    snapshots() {
      return {
        machines: sweeper.snapshot(),
        series: sweeper.series,
        capabilities
      }
    },

    slowTargets() {
      return [INTERVAL_KEY]
    },

    async refreshSlow() {
      if (!ctx.connected) return
      const available = await refreshCapabilities(true)
      if (!available.problem) await sweeper.run()
    },

    dispose() {
      stopped = true
      capabilityGeneration += 1
      capabilityFlight = null
      sweeper.dispose()
      queries.reset()
      machines.clear()
    }
  }
}

export default activate
