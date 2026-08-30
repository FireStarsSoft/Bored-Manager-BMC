/**
 * The object graph, and the only file allowed to know every part of this
 * module exists. Nothing under `ipmi/`, `store/`, `sweep/` or `machines/` may
 * import this folder back.
 */
import type { ModuleContext } from '@shared/modules'
import { Actions } from '../actions'
import { MachineEditor } from '../machines'
import { Queries } from '../queries'
import { RulesEditor } from '../rules'
import { ConfigStore, Credentials, migratePlaintext } from '../store'
import { buildOverview, Incidents, OverviewPublisher, SeriesLog, Sweeper } from '../sweep'
import { CapabilityLatch } from './readiness'

export interface UiState {
  hintsOn: boolean
}

export interface BmcRuntime {
  ctx: ModuleContext
  config: ConfigStore
  credentials: Credentials
  series: SeriesLog
  sweeper: Sweeper
  incidents: Incidents
  overview: OverviewPublisher
  latch: CapabilityLatch
  queries: Queries
  actions: Actions
  machines: MachineEditor
  rules: RulesEditor
  /** Move any clear-text passwords into the secret store; safe to call twice. */
  migrate(): Promise<void>
  /** Re-derive readiness and the hints flag after the settings document changed. */
  publishUi(): void
  applyPollers(): void
  snapshots(): Record<string, unknown>
  reset(): void
  dispose(): void
}

export function createRuntime(ctx: ModuleContext): BmcRuntime {
  const config = new ConfigStore(ctx)
  const credentials = new Credentials(ctx)
  const series = new SeriesLog(ctx)
  const incidents = new Incidents(ctx)

  // The latch needs the sweeper to own its poller, and the sweeper needs the
  // latch to know whether it may run - so one of them is wired after the
  // fact. It is the sweeper's readiness check, because that is only ever
  // called from inside a sweep, long after both exist.
  let latchRef: CapabilityLatch | null = null
  const ensureReady = async (): Promise<boolean> =>
    latchRef ? latchRef.ensureReady(false) : false

  // Order matters here: the sweep poller is registered before the attention
  // ticker, so a poller list reads in the order the module actually works.
  const sweeper = new Sweeper(ctx, config, ensureReady, series, credentials, incidents)
  const overview = new OverviewPublisher(ctx)
  sweeper.onPublish = (payload) => overview.publish(payload)

  const latch = new CapabilityLatch(ctx, config, sweeper)
  latchRef = latch
  // The event log needs to know whether the clock that stamped it can be
  // trusted; it does not need to know how sweeping works.
  const queries = new Queries(ctx, config, credentials, (id, revision) =>
    sweeper.stateFor(id, revision)?.clock ?? null
  )
  const actions = new Actions(ctx, config, sweeper, queries, credentials)
  const machines = new MachineEditor(ctx, config, sweeper, queries, credentials)

  const publishUi = (): void => {
    ctx.emit('ui', { hintsOn: config.read().hintsOn } satisfies UiState)
    // Parking the last machine, or adding the first, changes whether a sweep
    // reaches anything - which is a readiness question, not a fleet one.
    latch.publish()
  }

  const rules = new RulesEditor(ctx, config, () => {
    publishUi()
    sweeper.publishCards()
  })

  /**
   * Move any clear-text passwords into the secret store, once.
   *
   * Only the elected primary runs it: `configSet` is last-writer-wins and
   * `activate` runs once per connected machine, so two instances rewriting the
   * same document could lose an edit. It is idempotent regardless - re-storing
   * the same secret is harmless and the second document write is identical -
   * and the other instances see the result through `onConfigChange`.
   *
   * Feature-detected as well as gated by `minAppVersion`: a module folder
   * copied in by hand never meets the installer that enforces the floor, and
   * "this needs a newer app" is a better thing to log than a TypeError.
   */
  const migrate = async (): Promise<void> => {
    if (!ctx.isPrimaryInstance) return
    if (!Credentials.available(ctx)) {
      if (config.read().machines.some((machine) => machine.password)) {
        ctx.log(
          'bmc: this app is older than 0.6.0 and has no secret store, so BMC passwords are staying in the settings file in clear text - update the app to move them'
        )
      }
      return
    }
    try {
      await migratePlaintext(ctx, config, credentials)
      const keep = new Set(config.read().machines.map((machine) => machine.id))
      const dropped = await credentials.prune(keep)
      if (dropped > 0) {
        ctx.log(`bmc: forgot ${dropped} saved password(s) for machines that no longer exist`)
      }
    } catch (error) {
      // Nothing has been removed if this threw: the passwords are still in the
      // document and the module goes on working from them, so the right answer
      // is to say so and try again next time rather than to fail activation.
      ctx.log(
        `bmc: could not move passwords into the app's secret store - ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  return {
    ctx,
    config,
    credentials,
    series,
    sweeper,
    incidents,
    overview,
    latch,
    queries,
    actions,
    machines,
    rules,
    migrate,
    publishUi,

    applyPollers() {
      latch.applySweepPoller()
    },

    snapshots() {
      return {
        machines: sweeper.snapshot(),
        series: series.points,
        capabilities: latch.snapshot(),
        // Never null: a browser that opens before the first sweep - or one
        // attached to the instance that is not the elected primary, which
        // never sweeps at all - would otherwise get no overview stream, and
        // the widget would read an unset fleet as an empty one and say so.
        overview: overview.latest ?? buildOverview(sweeper.snapshot()),
        ui: { hintsOn: config.read().hintsOn } satisfies UiState
      }
    },

    reset() {
      latch.reset()
      sweeper.reset()
      overview.reset()
      queries.reset()
      machines.clear()
      rules.clear()
      config.reset()
    },

    dispose() {
      credentials.dispose()
      latch.dispose()
      sweeper.dispose()
      overview.dispose()
      queries.reset()
      machines.clear()
      rules.clear()
      config.dispose()
    }
  }
}
