import type { ModuleContext } from '@shared/modules'
import {
  droppedMachineCount,
  emptyConfig,
  normalize,
  type BmcConfig,
  type BmcSettings
} from './schema'

/**
 * Config is shared by every connected-machine instance of this module, so the
 * normalised document is kept only until something writes it - `onConfigChange`
 * fires for every instance, this one included, so an edit made while viewing
 * another management station drops this copy rather than being overwritten by
 * it. Without the cache this parsed and re-validated the whole machine list
 * several times per sweep and once per 2 s table poll.
 *
 * The document handed out is the cache itself: callers read it, and the ones
 * that change it go through `update()`.
 */
export class ConfigStore {
  private cache: BmcConfig | null = null
  private warnedAboutDropped = false
  private disposed = false
  private readonly unsubscribe: () => void

  constructor(private ctx: ModuleContext) {
    this.unsubscribe = ctx.onConfigChange(() => {
      this.cache = null
    })
  }

  read(): BmcConfig {
    if (this.cache) return this.cache
    // Something still unwinding after dispose can reach this. Answering with
    // an empty document is better than asking a context that has been revoked,
    // which is logged against the module as work that outlived it.
    if (this.disposed) return emptyConfig()
    const raw = this.ctx.configGet()
    const config = normalize(raw)
    // Said once per load rather than per read: a truncated list is a fact the
    // user needs, and a line per sweep would bury it.
    if (!this.warnedAboutDropped) {
      const dropped = droppedMachineCount(raw)
      if (dropped > 0) {
        this.warnedAboutDropped = true
        this.ctx.log(
          `bmc: ${dropped} machine${dropped === 1 ? '' : 's'} past the limit were ignored - the module keeps the first ${config.machines.length}`
        )
      }
    }
    this.cache = config
    return config
  }

  settings(): BmcSettings {
    return this.read().settings
  }

  update<T>(mutate: (config: BmcConfig) => T): T {
    // Work on a copy. Mutating the cached document in place and writing it
    // afterwards means a write that throws - a full disk, a read-only volume,
    // a document over the size cap - leaves this module serving and acting on
    // a document that is not on disk, while the user has just been told the
    // change failed. The document is plain JSON by definition, so a round
    // trip is a faithful copy.
    const draft = JSON.parse(JSON.stringify(this.read())) as BmcConfig
    const result = mutate(draft)
    this.ctx.configSet(draft)
    // The change listener has just cleared the cache; this document is what
    // was written, so it is also what the next read should see.
    this.cache = draft
    return result
  }

  reset(): void {
    this.cache = null
  }

  /** Stop listening. The context drops the listener on revoke anyway; this is for a tidy dispose. */
  dispose(): void {
    this.unsubscribe()
    this.disposed = true
    this.cache = null
  }
}
