/**
 * Where the IPMI passwords live now.
 *
 * Until Bored Manager 0.6.0 they lived in this module's settings document, in
 * clear text, and every surface that showed the machine list had to say so.
 * That was not a design so much as the only thing available: a module could
 * persist JSON and nothing else. 0.6.0 gave modules a secret store encrypted
 * with the install's own key, and this is the layer that uses it.
 *
 * Three rules follow from how that store works, and they shape this file.
 *
 * **A password is read at the point of use and never kept.** There is no cache
 * here on purpose. Whatever this module holds in a field can end up in a
 * `snapshots()` payload or a handler's reply, and both of those reach a
 * browser; a value fetched for one `ipmitool` invocation and dropped cannot.
 * The cost is a map lookup and one decrypt per call, which is nothing beside
 * the network round trip it is about to pay for.
 *
 * **"Never set" and "cannot be read" are different answers, and the user needs
 * both.** If `data/secret.key` is replaced - a fresh install, a `data/`
 * restored without it - every stored password becomes undecryptable at once.
 * Treating that as "no password" would have the sweep authenticate with
 * nothing, over and over, against controllers that lock accounts for it. So an
 * unreadable credential is its own state, and it says which machine to re-enter.
 *
 * **The secret store is keyed by machine id.** Not by address or user name:
 * those are edited, and a credential that moved when somebody fixed a typo
 * would be orphaned. `id` is stable for the life of the entry.
 */
import type { ModuleContext } from '@shared/modules'
import type { BmcMachine, ConfigStore } from './index'

/** What a machine's credential is, without being the credential. */
export type CredentialState = 'saved' | 'missing' | 'unreadable'

export interface CredentialRead {
  password: string | null
  state: CredentialState
  /** A sentence for the UI when the password cannot be used. */
  problem: string | null
}

function keyFor(machineId: string): string {
  return `machine/${machineId}`
}

const MISSING =
  'No password is saved for this BMC. Open its row on the Module settings page and enter one.'

const UNREADABLE =
  'The saved password for this BMC cannot be read - the app\'s secret key is not the one it was written with. Open its row on the Module settings page and enter it again.'

export class Credentials {
  private stopped = false

  constructor(private ctx: ModuleContext) {}

  /**
   * Stop reaching for the context.
   *
   * Something is always still unwinding when a module is disposed - a settings
   * table mid-poll, a sweep waiting on a controller - and every one of those
   * paths comes through here. Asking a revoked context is logged against the
   * module as work that outlived it, so after this the answers come from
   * nowhere: no password, no error, nothing rendered anyway.
   */
  dispose(): void {
    this.stopped = true
  }

  /** True when the running app offers a secret store at all. */
  static available(ctx: ModuleContext): boolean {
    // Feature-detected as well as gated by `minAppVersion`, because a module
    // folder copied in by hand never goes through the installer that enforces
    // it, and a TypeError inside `activate` is a far worse way to find out.
    return typeof ctx.secretGet === 'function' && typeof ctx.secretSet === 'function'
  }

  async read(machine: BmcMachine): Promise<CredentialRead> {
    if (this.stopped) return { password: null, state: 'missing', problem: MISSING }
    try {
      const password = await this.ctx.secretGet(keyFor(machine.id))
      if (password == null || password === '') {
        return { password: null, state: 'missing', problem: MISSING }
      }
      return { password, state: 'saved', problem: null }
    } catch {
      // `secretGet` rejects for exactly one reason a caller can act on: the
      // value is there and this install can no longer open it.
      return { password: null, state: 'unreadable', problem: UNREADABLE }
    }
  }

  async write(machineId: string, password: string): Promise<void> {
    if (this.stopped) throw new Error('this module has stopped - the password was not saved')
    await this.ctx.secretSet(keyFor(machineId), password)
  }

  async forget(machineId: string): Promise<void> {
    if (this.stopped) return
    try {
      await this.ctx.secretDelete(keyFor(machineId))
    } catch {
      // Deleting a machine should not fail because its credential was already
      // gone, or because the store refused; the row is what the user asked to
      // remove, and an orphaned secret is reconciled by `prune` below.
    }
  }

  /**
   * What the settings table shows per row, without reading a single password.
   *
   * `secretList` answers with names and metadata only, so this can say "saved"
   * or "enter it again" for the whole fleet in one call.
   */
  async states(): Promise<Map<string, CredentialState>> {
    const out = new Map<string, CredentialState>()
    if (this.stopped) return out
    try {
      for (const entry of await this.ctx.secretList()) {
        if (!entry.key.startsWith('machine/')) continue
        out.set(entry.key.slice('machine/'.length), entry.readable ? 'saved' : 'unreadable')
      }
    } catch {
      // A store that cannot be listed is reported as nothing saved rather than
      // as an error per row; the sweep will say what is actually wrong.
    }
    return out
  }

  /**
   * Drop credentials for machines that no longer exist.
   *
   * Deleting a row already forgets its password, so this only catches the
   * cases that route around that - a config document edited by hand, or a
   * delete that raced a write. Without it the store slowly fills with
   * passwords for machines nobody can see, which is the worst kind of leftover.
   */
  async prune(keep: ReadonlySet<string>): Promise<number> {
    let dropped = 0
    for (const [machineId] of await this.states()) {
      if (keep.has(machineId)) continue
      await this.forget(machineId)
      dropped += 1
    }
    return dropped
  }
}

/**
 * Move any clear-text passwords out of the settings document.
 *
 * Deliberately ordered so that a failure at any point leaves something that
 * still works: every password is written to the secret store first, and only
 * once all of them are safely there is the document rewritten without them. A
 * half-migrated document - some machines moved, some not - is the one state
 * with no good recovery, so it is never written.
 *
 * Runs on the elected primary instance only. `configSet` is last-writer-wins
 * with no compare-and-swap and `activate` runs once per connected machine, so
 * two instances migrating at once could lose an edit. It is idempotent anyway:
 * re-writing the same secret is harmless and the second document write would
 * be byte-identical.
 */
export async function migratePlaintext(
  ctx: ModuleContext,
  store: ConfigStore,
  credentials: Credentials
): Promise<number> {
  const config = store.read()
  const legacy = config.machines.filter((machine) => Boolean(machine.password))
  if (legacy.length === 0) return 0

  for (const machine of legacy) {
    // If any of these throws, nothing has been removed yet: the module keeps
    // running from the clear-text document exactly as it did before, and the
    // migration is retried on the next activation.
    await credentials.write(machine.id, machine.password as string)
  }

  store.update((draft) => {
    for (const machine of draft.machines) delete machine.password
    draft.version = 3
  })
  ctx.log(
    `bmc: moved ${legacy.length} BMC password${legacy.length === 1 ? '' : 's'} out of the settings file and into the app's encrypted store`
  )
  return legacy.length
}
