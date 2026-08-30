import { describe, expect, it } from 'vitest'
import type { ModuleContext } from '@shared/modules'
import {
  moduleHarness,
  sharedModuleConfig,
  type ModuleHarnessOptions,
  type SharedModuleConfig
} from '../helpers/module-harness'
import {
  ConfigStore,
  Credentials,
  migratePlaintext,
  type BmcConfig,
  type BmcMachine
} from '../../bmc/main/store'

/**
 * The credential layer, which is the whole point of the 0.6.0 rework: BMC
 * passwords left the settings document and moved into the app's encrypted
 * secret store.
 *
 * Two things here are load-bearing beyond "it stores and reads a string".
 *
 * The first is that "never set" and "cannot be read" are distinct answers. A
 * `data/secret.key` that was replaced makes every stored password undecryptable
 * at once; reporting that as "no password" would have the sweep authenticate
 * with nothing, repeatedly, against controllers that lock accounts for it. So
 * the two states carry different sentences, and this file pins that they are
 * different.
 *
 * The second is the ordering inside `migratePlaintext`. Every password reaches
 * the secret store before the document is rewritten without them, so a store
 * that refuses mid-way leaves a module that still works from clear text rather
 * than a fleet of machines with no credential anywhere.
 */

function harnessWith(options: ModuleHarnessOptions = {}) {
  return moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 0 }), options)
}

function machine(id: string, overrides: Partial<BmcMachine> = {}): BmcMachine {
  return {
    id,
    revision: `r-${id}`,
    name: id,
    ip: `10.0.0.${id.replace(/\D/g, '') || '1'}`,
    port: 623,
    username: 'admin',
    enabled: true,
    ...overrides
  }
}

describe('Credentials.read', () => {
  it('answers the stored password for a machine that has one', async () => {
    const harness = harnessWith({ secrets: { 'machine/m1': 'hunter2' } })
    const credentials = new Credentials(harness.ctx)

    expect(await credentials.read(machine('m1'))).toEqual({
      password: 'hunter2',
      state: 'saved',
      problem: null
    })
  })

  it('reports missing - with no password at all - when nothing was ever stored', async () => {
    const harness = harnessWith()
    const credentials = new Credentials(harness.ctx)

    const read = await credentials.read(machine('m1'))

    expect(read.state).toBe('missing')
    // Never '': an empty string is a password `ipmitool` would happily send.
    expect(read.password).toBeNull()
    expect(read.problem).toMatch(/no password is saved/i)
    expect(read.problem).toMatch(/module settings/i)
  })

  it('treats a stored empty string as missing rather than as a usable password', async () => {
    const harness = harnessWith({ secrets: { 'machine/m1': '' } })
    const credentials = new Credentials(harness.ctx)

    const read = await credentials.read(machine('m1'))

    expect(read.state).toBe('missing')
    expect(read.password).toBeNull()
  })

  it('reports unreadable, not missing, when the value is there but will not decrypt', async () => {
    const harness = harnessWith({
      secrets: { 'machine/m1': 'hunter2' },
      unreadableSecrets: ['machine/m1']
    })
    const credentials = new Credentials(harness.ctx)

    const read = await credentials.read(machine('m1'))

    expect(read.state).toBe('unreadable')
    expect(read.password).toBeNull()
    expect(read.problem).toMatch(/again/i)
  })

  it('says something different for unreadable than for missing', async () => {
    const empty = new Credentials(harnessWith().ctx)
    const broken = new Credentials(
      harnessWith({ secrets: { 'machine/m1': 'hunter2' }, unreadableSecrets: ['machine/m1'] }).ctx
    )

    const missing = await empty.read(machine('m1'))
    const unreadable = await broken.read(machine('m1'))

    // The distinction is the reason this API exists: one asks for a password
    // that was never set, the other says a saved one has to be typed again.
    expect(missing.problem).not.toBe(unreadable.problem)
    expect(missing.problem).toBeTruthy()
    expect(unreadable.problem).toBeTruthy()
  })

  it('keys by machine id, so one machine cannot read another machine\'s password', async () => {
    const harness = harnessWith({ secrets: { 'machine/m1': 'hunter2' } })
    const credentials = new Credentials(harness.ctx)

    expect((await credentials.read(machine('m2'))).state).toBe('missing')
  })
})

describe('Credentials.write / forget', () => {
  it('round-trips a password through the store under machine/<id>', async () => {
    const harness = harnessWith()
    const credentials = new Credentials(harness.ctx)

    await credentials.write('m1', 'correct horse')

    expect(await credentials.read(machine('m1'))).toEqual({
      password: 'correct horse',
      state: 'saved',
      problem: null
    })
    expect((await harness.ctx.secretList()).map((entry) => entry.key)).toEqual(['machine/m1'])
  })

  it('replaces what was there, rather than adding a second entry', async () => {
    const harness = harnessWith({ secrets: { 'machine/m1': 'old' } })
    const credentials = new Credentials(harness.ctx)

    await credentials.write('m1', 'new')

    expect((await credentials.read(machine('m1'))).password).toBe('new')
    expect(await harness.ctx.secretList()).toHaveLength(1)
  })

  it('makes a later read report missing once the credential is forgotten', async () => {
    const harness = harnessWith({ secrets: { 'machine/m1': 'hunter2' } })
    const credentials = new Credentials(harness.ctx)

    await credentials.forget('m1')

    const read = await credentials.read(machine('m1'))
    expect(read.state).toBe('missing')
    expect(read.password).toBeNull()
    expect(await harness.ctx.secretList()).toEqual([])
  })

  it('does not throw when asked to forget a machine that never had one', async () => {
    const credentials = new Credentials(harnessWith().ctx)

    // Deleting a row must not fail because its password was already gone.
    await expect(credentials.forget('never-existed')).resolves.toBeUndefined()
  })
})

describe('Credentials.states', () => {
  it('answers the whole fleet in one pass, without any password in it', async () => {
    const harness = harnessWith({
      secrets: {
        'machine/m1': 'hunter2',
        'machine/m2': 'swordfish',
        'ipmi-token': 'unrelated'
      },
      unreadableSecrets: ['machine/m2']
    })
    const credentials = new Credentials(harness.ctx)

    const states = await credentials.states()

    expect([...states.entries()].sort()).toEqual([
      ['m1', 'saved'],
      ['m2', 'unreadable']
    ])
    // The settings table renders straight from this, so it must not be able to
    // carry a secret out to a browser.
    const serialised = JSON.stringify([...states.entries()])
    expect(serialised).not.toContain('hunter2')
    expect(serialised).not.toContain('swordfish')
  })

  it('ignores keys that are not machine credentials', async () => {
    const harness = harnessWith({
      secrets: { 'ipmi-token': 'unrelated', 'machine/m1': 'hunter2' }
    })

    const states = await new Credentials(harness.ctx).states()

    expect([...states.keys()]).toEqual(['m1'])
  })

  it('is empty, not an error, when nothing has ever been stored', async () => {
    expect(await new Credentials(harnessWith().ctx).states()).toEqual(new Map())
  })
})

describe('Credentials.prune', () => {
  it('forgets exactly the machines that are gone and answers how many', async () => {
    const harness = harnessWith({
      secrets: {
        'machine/m1': 'one',
        'machine/m2': 'two',
        'machine/m3': 'three',
        'ipmi-token': 'unrelated'
      },
      // An orphan whose key can no longer be read is still an orphan.
      unreadableSecrets: ['machine/m3']
    })
    const credentials = new Credentials(harness.ctx)

    const dropped = await credentials.prune(new Set(['m1']))

    expect(dropped).toBe(2)
    expect((await harness.ctx.secretList()).map((entry) => entry.key)).toEqual([
      // Sorted by key: the unrelated secret is left exactly where it was.
      'ipmi-token',
      'machine/m1'
    ])
  })

  it('drops nothing, and says so, when every stored credential is still in use', async () => {
    const harness = harnessWith({ secrets: { 'machine/m1': 'one', 'machine/m2': 'two' } })
    const credentials = new Credentials(harness.ctx)

    expect(await credentials.prune(new Set(['m1', 'm2']))).toBe(0)
    expect(await harness.ctx.secretList()).toHaveLength(2)
  })

  it('does not count machines that are configured but have no credential stored', async () => {
    const harness = harnessWith({ secrets: { 'machine/m1': 'one' } })
    const credentials = new Credentials(harness.ctx)

    expect(await credentials.prune(new Set(['m1', 'm2', 'm3']))).toBe(0)
  })
})

describe('Credentials.available', () => {
  it('is true for a context from an app that has a secret store', () => {
    expect(Credentials.available(harnessWith().ctx)).toBe(true)
  })

  it('is false for a context without one, rather than throwing inside activate', () => {
    // What an older host hands a module folder that was copied in by hand and
    // so never went through the installer that enforces minAppVersion.
    const older = { id: 'bmc', log: () => {} } as unknown as ModuleContext

    expect(Credentials.available(older)).toBe(false)
  })
})

/* ---------------------------------------------------------------------- */

/** A shared config document whose writes can be counted and inspected. */
function tracked(seed: unknown): { config: SharedModuleConfig; writes: () => BmcConfig[] } {
  const inner = sharedModuleConfig(seed)
  const writes: BmcConfig[] = []
  return {
    writes: () => writes,
    config: {
      ...inner,
      set: (value) => {
        writes.push(value as BmcConfig)
        inner.set(value)
      }
    }
  }
}

/** A pre-0.6.0 document: three machines, three clear-text passwords. */
function legacyDoc(): unknown {
  return {
    version: 2,
    machines: [
      {
        id: 'm1',
        revision: 'r1',
        name: 'Chassis',
        ip: '10.0.0.1',
        port: 623,
        username: 'admin',
        password: 'pw-one',
        enabled: true
      },
      {
        id: 'm2',
        revision: 'r2',
        name: 'Spare',
        ip: '10.0.0.2',
        port: 623,
        username: 'root',
        password: 'pw-two',
        enabled: true
      },
      {
        id: 'm3',
        revision: 'r3',
        name: 'Lab',
        ip: '10.0.0.3',
        port: 664,
        username: 'operator',
        password: 'pw-three',
        enabled: false
      }
    ],
    settings: { sweepConcurrency: 2, sensorEverySweeps: 3, selFetchCount: 100, identifySeconds: 15 },
    hintsOn: true
  }
}

interface MigrationRig {
  config: SharedModuleConfig
  writes: () => BmcConfig[]
  store: ConfigStore
  credentials: Credentials
  ctx: ModuleContext
  /** The document as it now stands on "disk", read back through the shared config. */
  onDisk(): BmcConfig
}

function migrationRig(seed: unknown, options: ModuleHarnessOptions = {}): MigrationRig {
  const { config, writes } = tracked(seed)
  const harness = harnessWith({ ...options, config })
  const store = new ConfigStore(harness.ctx)
  return {
    config,
    writes,
    store,
    ctx: harness.ctx,
    credentials: new Credentials(harness.ctx),
    // A second store over the same shared config: what the next activation, or
    // another connected machine's instance, would read.
    onDisk: () => new ConfigStore(harnessWith({ config }).ctx).read()
  }
}

describe('migratePlaintext', () => {
  it('moves every password into the store and rewrites the document without them', async () => {
    const rig = migrationRig(legacyDoc())

    expect(await migratePlaintext(rig.ctx, rig.store, rig.credentials)).toBe(3)

    expect(await rig.ctx.secretGet('machine/m1')).toBe('pw-one')
    expect(await rig.ctx.secretGet('machine/m2')).toBe('pw-two')
    expect(await rig.ctx.secretGet('machine/m3')).toBe('pw-three')

    const onDisk = rig.onDisk()
    expect(onDisk.version).toBe(3)
    expect(onDisk.machines.map((entry) => entry.id)).toEqual(['m1', 'm2', 'm3'])
    for (const entry of onDisk.machines) expect(entry.password).toBeUndefined()

    // Belt and braces on the raw bytes: `normalize` drops an empty password, so
    // an undefined field alone would not prove the document lost the value.
    const raw = rig.writes().at(-1) as BmcConfig
    expect(raw.version).toBe(3)
    for (const entry of raw.machines) expect(Object.hasOwn(entry, 'password')).toBe(false)
    expect(JSON.stringify(raw)).not.toContain('pw-one')
    expect(JSON.stringify(raw)).not.toContain('pw-two')
    expect(JSON.stringify(raw)).not.toContain('pw-three')
  })

  it('leaves everything else in the document alone', async () => {
    const rig = migrationRig(legacyDoc())

    await migratePlaintext(rig.ctx, rig.store, rig.credentials)

    const onDisk = rig.onDisk()
    expect(onDisk.settings.sweepConcurrency).toBe(2)
    expect(onDisk.hintsOn).toBe(true)
    expect(onDisk.machines[2]).toMatchObject({
      id: 'm3',
      name: 'Lab',
      ip: '10.0.0.3',
      port: 664,
      username: 'operator',
      enabled: false
    })
  })

  it('is idempotent: a second run writes nothing and answers 0', async () => {
    const rig = migrationRig(legacyDoc())
    expect(await migratePlaintext(rig.ctx, rig.store, rig.credentials)).toBe(3)
    const writesAfterFirst = rig.writes().length

    expect(await migratePlaintext(rig.ctx, rig.store, rig.credentials)).toBe(0)

    expect(rig.writes()).toHaveLength(writesAfterFirst)
    expect(await rig.ctx.secretGet('machine/m1')).toBe('pw-one')
  })

  it('is a no-op on a document that has no passwords left', async () => {
    const rig = migrationRig({
      version: 3,
      machines: [{ id: 'm1', revision: 'r1', name: 'Chassis', ip: '10.0.0.1', port: 623, username: 'admin', enabled: true }],
      settings: { sweepConcurrency: 4, sensorEverySweeps: 3, selFetchCount: 100, identifySeconds: 15 },
      hintsOn: true
    })

    expect(await migratePlaintext(rig.ctx, rig.store, rig.credentials)).toBe(0)

    expect(rig.writes()).toEqual([])
    expect(await rig.ctx.secretList()).toEqual([])
  })

  it('is a no-op on an empty document', async () => {
    const rig = migrationRig(null)

    expect(await migratePlaintext(rig.ctx, rig.store, rig.credentials)).toBe(0)
    expect(rig.writes()).toEqual([])
  })

  /**
   * The ordering guarantee. Passwords go to the store first and the document is
   * rewritten only once all of them are there, so a store that refuses part way
   * through leaves a module that still works from clear text - never a fleet of
   * machines whose credential exists nowhere.
   */
  it('leaves the document untouched, with every password still in it, when a write is refused', async () => {
    // Room for two of the three credentials: the third `secretSet` is refused
    // the way the host refuses one past a module's granted entry count.
    const rig = migrationRig(legacyDoc(), {
      storageGrant: { secrets: { requestedEntries: 2, grantedEntries: 2, valueBytes: 4 * 1024 } }
    })

    await expect(migratePlaintext(rig.ctx, rig.store, rig.credentials)).rejects.toThrow(/2 secrets/)

    // Half one: nothing was written to the document at all.
    expect(rig.writes()).toEqual([])
    const onDisk = rig.onDisk()
    expect(onDisk.version).toBe(2)
    expect(onDisk.machines.map((entry) => entry.password)).toEqual(['pw-one', 'pw-two', 'pw-three'])

    // Half two: the running module still sees every password, so the sweep goes
    // on authenticating exactly as it did before the attempt.
    expect(rig.store.read().machines.map((entry) => entry.password)).toEqual([
      'pw-one',
      'pw-two',
      'pw-three'
    ])
    // And the credential that never landed is reported honestly, rather than as
    // a password that exists.
    expect((await rig.credentials.read(machine('m3'))).state).toBe('missing')
  })

  it('leaves the document untouched when the very first write is refused', async () => {
    // A value cap small enough that no password fits: the loop fails before
    // anything at all has been stored.
    const rig = migrationRig(legacyDoc(), {
      storageGrant: { secrets: { requestedEntries: 32, grantedEntries: 32, valueBytes: 4 } }
    })

    await expect(migratePlaintext(rig.ctx, rig.store, rig.credentials)).rejects.toThrow(/bytes/)

    expect(rig.writes()).toEqual([])
    expect(await rig.ctx.secretList()).toEqual([])
    expect(rig.onDisk().machines.map((entry) => entry.password)).toEqual([
      'pw-one',
      'pw-two',
      'pw-three'
    ])
    expect(rig.onDisk().version).toBe(2)
  })

  it('completes on the retry once the store will take them', async () => {
    const rig = migrationRig(legacyDoc(), {
      storageGrant: { secrets: { requestedEntries: 2, grantedEntries: 2, valueBytes: 4 * 1024 } }
    })
    await expect(migratePlaintext(rig.ctx, rig.store, rig.credentials)).rejects.toThrow()

    // The next activation, against a store with room - the two credentials that
    // already landed are simply written again.
    const roomy = migrationRig(rig.config.get(), {
      secrets: { 'machine/m1': 'pw-one', 'machine/m2': 'pw-two' }
    })
    expect(await migratePlaintext(roomy.ctx, roomy.store, roomy.credentials)).toBe(3)

    expect(roomy.onDisk().version).toBe(3)
    expect(roomy.onDisk().machines.every((entry) => entry.password === undefined)).toBe(true)
    expect(await roomy.ctx.secretGet('machine/m3')).toBe('pw-three')
  })
})
