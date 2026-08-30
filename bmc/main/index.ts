/**
 * BMC management through `ipmitool` on the machine Bored Manager is connected
 * to. That machine is the management station; the targets are a list of BMC
 * endpoints the user maintains, reached over IPMI 2.0 lanplus.
 *
 * Network polling is slow and bounded: one pass over the fleet on the slow
 * interval, sensors on a slower cadence than power, and detail reads only
 * while somebody has the drawer open. Everything else lives under `runtime/`.
 */
import type { ModuleActivate, ModuleContext } from '@shared/modules'
import { createRuntime, registerHandlers } from './runtime'
import { INTERVAL_KEY } from './sweep'

const activate: ModuleActivate = (ctx: ModuleContext) => {
  const runtime = createRuntime(ctx)
  registerHandlers(runtime)
  runtime.publishUi()
  // Detached on purpose: activation must not wait on the secret store, and a
  // module that failed to start because a migration was slow would be a worse
  // outcome than one whose passwords move a moment later. It logs its own
  // failures and leaves the clear-text document working if it cannot finish.
  void runtime.migrate()

  return {
    applyPollers() {
      runtime.applyPollers()
    },

    reset() {
      runtime.reset()
    },

    snapshots() {
      return runtime.snapshots()
    },

    slowTargets() {
      return [INTERVAL_KEY]
    },

    async refreshSlow() {
      if (!ctx.connected) return
      if (await runtime.latch.ensureReady(true)) await runtime.sweeper.run()
    },

    dispose() {
      runtime.dispose()
    }
  }
}

export default activate
