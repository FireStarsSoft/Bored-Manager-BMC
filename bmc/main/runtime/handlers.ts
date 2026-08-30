/**
 * Every method this module answers, in one place.
 *
 * The list here has to match `manifest.methods` exactly - the host refuses to
 * register anything the manifest does not declare, and the contract test
 * fails a manifest entry nothing registers.
 */
import type { OkResult } from '@shared/types'
import type { BmcRuntime } from './container'

export function registerHandlers(runtime: BmcRuntime): void {
  const { ctx, machines, queries, actions, sweeper, latch, rules, incidents } = runtime

  ctx.handle('machineRows', () => machines.rows())

  // Both forms of the same form: three arguments when a row is being edited,
  // one when a machine is being added.
  ctx.handle('machineCheck', (...args: unknown[]) =>
    args.length >= 3
      ? machines.check(String(args[0]), String(args[1]), args[2])
      : machines.check(null, null, args[0])
  )
  // Adding, removing and parking a machine all change how many are being
  // swept, which is what readiness is derived from - so each of them has to
  // republish it, or the pages go on rendering "nothing is being swept" over
  // a fleet that plainly is.
  ctx.handle('machineApply', async (...args: unknown[]) => {
    const result =
      args.length >= 3
        ? await machines.apply(String(args[0]), String(args[1]), args[2])
        : await machines.apply(null, null, args[0])
    if (result.ok) runtime.publishUi()
    return result
  })
  ctx.handle('machineDelete', async (id: unknown, revision: unknown) => {
    const result = await machines.delete(id, revision)
    if (result.ok) runtime.publishUi()
    return result
  })
  ctx.handle('machineTest', (id: unknown, revision: unknown) => machines.test(id, revision))
  ctx.handle('machineEnable', (id: unknown, revision: unknown) => {
    const result = machines.setEnabled(id, revision)
    if (result.ok) runtime.publishUi()
    return result
  })

  ctx.handle('machineInspect', (id: unknown, revision: unknown) =>
    queries.machineInspect(id, revision)
  )
  ctx.handle('sensorRows', (id: unknown, revision: unknown) => queries.sensorRows(id, revision))
  ctx.handle('selRows', (id: unknown, revision: unknown) => queries.selRows(id, revision))
  // Built from what the sweep already collected, so this costs nothing on the
  // network and can be polled like any other table.
  ctx.handle('attentionRows', () => sweeper.attentionRows())
  // Read from the record set, which outlives the metrics window by months -
  // this is the one thing here that can answer "how long has this been going on".
  ctx.handle('incidentRows', () => incidents.recent())

  ctx.handle('powerAction', (id: unknown, revision: unknown, action: unknown) =>
    actions.powerAction(id, revision, action)
  )
  ctx.handle('selClear', (id: unknown, revision: unknown) => actions.selClear(id, revision))
  // A `bulkActions` button sends the ticked row keys first, then its own args.
  ctx.handle('powerBulk', (ids: unknown, action: unknown) => actions.powerBulk(ids, action))
  // Answers a command line rather than running one: the app opens the PTY, and
  // the point is that the command never passes through the browser.
  ctx.handle('solCommand', (id: unknown, revision: unknown) => actions.solCommand(id, revision))
  ctx.handle(
    'bootDevSet',
    (id: unknown, revision: unknown, device: unknown, persistent: unknown) =>
      actions.bootDevSet(id, revision, device, persistent)
  )
  ctx.handle('identify', (id: unknown, revision: unknown, seconds: unknown) =>
    actions.identify(id, revision, seconds)
  )

  ctx.handle('sweepNow', async (): Promise<OkResult> => {
    // A manual refresh ignores the primary election on purpose: somebody
    // pressed a button on this machine, and telling them another instance
    // owns the sweep would be an implementation detail refusing to work.
    if (!ctx.connected) {
      return { ok: false, error: 'not connected to a management machine' }
    }
    const ready = await latch.ensureReady(true)
    if (!ready) {
      return { ok: false, error: latch.snapshot().problem ?? 'the connected machine is not ready' }
    }
    await sweeper.run()
    return { ok: true }
  })

  ctx.handle('rulesEffective', () => rules.effective())
  ctx.handle('rulesCheck', (values: unknown) => rules.check(values))
  ctx.handle('rulesApply', (values: unknown) => rules.apply(values))
  ctx.handle('rulesReset', () => rules.reset())
  ctx.handle('hintsSet', (values: unknown) => rules.hintsSet(values))
}

/** The manifest's `methods`, as this file registers them. */
export const METHODS: readonly string[] = [
  'machineRows',
  'machineCheck',
  'machineApply',
  'machineDelete',
  'machineTest',
  'machineEnable',
  'machineInspect',
  'sensorRows',
  'selRows',
  'attentionRows',
  'incidentRows',
  'powerAction',
  'selClear',
  'powerBulk',
  'solCommand',
  'bootDevSet',
  'identify',
  'sweepNow',
  'rulesEffective',
  'rulesCheck',
  'rulesApply',
  'rulesReset',
  'hintsSet'
]
