import { describe, expect, it } from 'vitest'
import { moduleHarness, sharedModuleConfig, type SharedModuleConfig } from '../helpers/module-harness'
import {
  ConfigStore,
  DEFAULT_SETTINGS,
  MAX_MACHINES,
  SETTING_LIMITS,
  clampSetting,
  droppedMachineCount,
  machineAddress,
  machineFingerprint,
  normalize,
  type BmcMachine,
  type BmcSettings
} from '../../bmc/main/store'

/**
 * The settings document is the one thing in this module a user can lose: it
 * names hand-typed BMC endpoints that exist nowhere else. So the reader has to
 * survive a hand-edited file, and every upgrade has to be silent - an existing
 * rack must come back swept and readable, not parked.
 *
 * There are two of those upgrades now. Version 1 -> 2 added `enabled`,
 * `settings` and `hintsOn`. Version 2 -> 3 took the passwords out: they live in
 * the app's encrypted secret store from 0.6.0 onwards, and this document only
 * still carries one until the migration has moved it. `version` says which of
 * those two states the document is actually in - 3 once nothing is left to
 * move, 2 while anything is - rather than which module version wrote it.
 */

type RawEntry = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** A raw on-disk entry; every field is overridable with whatever a hand edit might leave. */
function entry(overrides: RawEntry = {}): RawEntry {
  return {
    id: 'm1',
    revision: 'r1',
    name: 'Rack A iDRAC',
    ip: '10.0.0.5',
    port: 623,
    username: 'root',
    password: 'calvin',
    ...overrides
  }
}

function machine(overrides: Partial<BmcMachine> = {}): BmcMachine {
  return {
    id: 'm1',
    revision: 'r1',
    name: 'Rack A iDRAC',
    ip: '10.0.0.5',
    port: 623,
    username: 'root',
    password: 'calvin',
    enabled: true,
    ...overrides
  }
}

/** What the module wrote before `enabled`, `settings` and `hintsOn` existed. */
const V1_DOCUMENT = {
  version: 1,
  machines: [
    {
      id: 'm7k2-a1c3',
      revision: 'r7k2-11ab22cd',
      name: 'Rack A iDRAC',
      ip: '10.0.0.5',
      port: 623,
      username: 'root',
      password: 'calvin'
    },
    {
      id: 'm7k2-b4d6',
      revision: 'r7k2-33ef44ab',
      name: 'Rack B iLO',
      ip: '10.0.0.6',
      port: 664,
      username: 'Administrator',
      password: 'hunter2'
    }
  ]
}

function docOf(count: number): { machines: RawEntry[] } {
  return {
    machines: Array.from({ length: count }, (_unused, index) =>
      entry({ id: `m${index}`, ip: `10.0.${Math.floor(index / 256)}.${index % 256}` })
    )
  }
}

describe('normalize: reading a document written by an older version', () => {
  it('reads a version 1 document with every machine still swept', () => {
    const config = normalize(clone(V1_DOCUMENT))

    // Still 2, and only because its passwords have not been moved yet - the
    // number describes the document, not the module that read it.
    expect(config.version).toBe(2)
    // Version 1 had no `enabled` and swept everything. Reading absence as
    // "parked" would silently stop watching an entire rack on upgrade.
    expect(config.machines.map((item) => item.enabled)).toEqual([true, true])
    expect(config.settings).toEqual(DEFAULT_SETTINGS)
    expect(config.hintsOn).toBe(true)
  })

  it('carries every version 1 field through untouched, so nothing has to be retyped', () => {
    const config = normalize(clone(V1_DOCUMENT))

    expect(config.machines[0]).toEqual({
      id: 'm7k2-a1c3',
      revision: 'r7k2-11ab22cd',
      name: 'Rack A iDRAC',
      ip: '10.0.0.5',
      port: 623,
      username: 'root',
      password: 'calvin',
      enabled: true
    })
    expect(config.machines[1].port).toBe(664)
    expect(config.machines[1].username).toBe('Administrator')
  })

  it('is pure: it neither mutates the document it was handed nor hands back a piece of it', () => {
    const raw = clone(V1_DOCUMENT)
    const untouched = JSON.stringify(raw)

    const config = normalize(raw)

    // The upgrade lands on the next `update()`. Merely opening the page on a
    // new module version must leave a file the previous version can read.
    expect(JSON.stringify(raw)).toBe(untouched)
    expect(config).not.toBe(raw)
    expect(config.machines).not.toBe(raw.machines)
    expect(config.machines[0]).not.toBe(raw.machines[0])
    // A copy, not the shared constant: a caller that edits settings in place
    // must not be able to move the module-wide defaults.
    expect(config.settings).not.toBe(DEFAULT_SETTINGS)
  })

  it('falls back to an entirely empty document when the file holds no object at all', () => {
    for (const raw of [null, undefined, 'corrupt', 42, []]) {
      const config = normalize(raw)
      // Version 3: there are no machines, so there is nothing left to move to
      // the secret store, and a fresh install should never look mid-migration.
      expect(config).toEqual({ version: 3, machines: [], settings: DEFAULT_SETTINGS, hintsOn: true })
    }
  })

  it('turns hints off only on an explicit false, the same rule the machines get', () => {
    expect(normalize({ hintsOn: false }).hintsOn).toBe(false)
    expect(normalize({ hintsOn: true }).hintsOn).toBe(true)
    expect(normalize({ hintsOn: null }).hintsOn).toBe(true)
    expect(normalize({}).hintsOn).toBe(true)
  })
})

/**
 * `version` is the migration's own state, and the only thing that reads it is a
 * person looking at the file. Passwords moved into the app's encrypted secret
 * store in 0.6.0; a document that still names one has not been migrated yet, so
 * it is version 2, and the migration finds the value because `normalize` was
 * careful to carry it through rather than drop a field it no longer models.
 */
describe('normalize: the version 2 to version 3 move of the passwords', () => {
  it('answers 3 for a document where no machine carries a password', () => {
    expect(normalize({ machines: [entry({ password: undefined })] }).version).toBe(3)
    expect(normalize({ machines: [entry({ password: '' })] }).version).toBe(3)
    expect(normalize({ machines: [] }).version).toBe(3)
    // Even one a hand edit called version 2: the number says what is true of
    // the document now, not what the last writer claimed.
    expect(normalize({ version: 2, machines: [entry({ password: undefined })] }).version).toBe(3)
  })

  it('answers 2 while any machine still carries one, however many do not', () => {
    const config = normalize({
      version: 3,
      machines: [
        entry({ id: 'moved', ip: '10.0.0.1', password: undefined }),
        entry({ id: 'still-here', ip: '10.0.0.2', password: 'calvin' })
      ]
    })

    // A document claiming 3 with a password left in it is mid-migration, and
    // reporting it as finished would leave that password in clear text forever.
    expect(config.version).toBe(2)
  })

  it('carries a legacy password through, because the migration is what reads it', () => {
    const config = normalize({ machines: [entry({ password: ' calvin ' })] })

    // Dropped here, the value would be unrecoverable: the document is the only
    // place it exists until `migratePlaintext` writes it to the secret store.
    // Verbatim, too - a BMC password may legitimately end in a space.
    expect(config.machines[0].password).toBe(' calvin ')
  })

  it('leaves the field off entirely once the password is gone, rather than storing an empty one', () => {
    const config = normalize({ machines: [entry({ password: '' }), entry({ id: 'm2', ip: '10.0.0.9' })] })

    // `migratePlaintext` and the version rule both test truthiness, so an
    // empty string left behind would read as "still to move" forever.
    expect(config.machines[0]).not.toHaveProperty('password')
    expect(config.machines[0].password).toBeUndefined()
    expect(config.machines[1].password).toBe('calvin')
  })
})

describe('normalize: parking a machine', () => {
  it('parks a machine on an explicit false and on nothing else', () => {
    const config = normalize({
      machines: [
        entry({ id: 'explicit-false', enabled: false }),
        entry({ id: 'explicit-true', enabled: true }),
        entry({ id: 'absent' }),
        entry({ id: 'undefined', enabled: undefined }),
        entry({ id: 'null', enabled: null }),
        entry({ id: 'empty-string', enabled: '' }),
        entry({ id: 'zero', enabled: 0 })
      ]
    })

    // Only `=== false` parks. Anything else falsy is a hand-edit artefact or a
    // version 1 document, and both mean "swept".
    expect(config.machines.map((item) => [item.id, item.enabled])).toEqual([
      ['explicit-false', false],
      ['explicit-true', true],
      ['absent', true],
      ['undefined', true],
      ['null', true],
      ['empty-string', true],
      ['zero', true]
    ])
  })
})

describe('normalize: defensive reading of a hand-edited list', () => {
  it('drops entries that are not objects and entries with no ip or no username', () => {
    const config = normalize({
      version: 2,
      machines: [
        'not an object',
        null,
        42,
        entry({ id: 'keep-1', ip: '10.0.0.5' }),
        entry({ id: 'blank-ip', ip: '   ' }),
        entry({ id: 'no-ip', ip: undefined }),
        entry({ id: 'no-username', username: '' }),
        entry({ id: 'keep-2', ip: '10.0.0.6' })
      ]
    })

    // An entry with no address or no login can never be asked anything; it
    // would only ever be a row that fails forever.
    expect(config.machines.map((item) => item.id)).toEqual(['keep-1', 'keep-2'])
  })

  it('gives a missing or duplicate id a positional legacy id and keeps every id unique', () => {
    const config = normalize({
      machines: [
        entry({ id: 'mlegacy-3', ip: '10.0.0.1' }),
        entry({ id: '', ip: '10.0.0.2' }),
        entry({ id: '   ', ip: '10.0.0.3' }),
        entry({ id: undefined, ip: '10.0.0.4' }),
        entry({ id: 'mlegacy-3', ip: '10.0.0.5' })
      ]
    })

    const ids = config.machines.map((item) => item.id)
    // Position 3 wants `mlegacy-3`, which the hand-written first entry already
    // took, so it gets suffixed rather than colliding.
    expect(ids).toEqual(['mlegacy-3', 'mlegacy-1', 'mlegacy-2', 'mlegacy-3-2', 'mlegacy-4'])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('numbers a positional legacy id in base 36, and counts the positions it dropped', () => {
    const entries: unknown[] = Array.from({ length: 13 }, (_unused, index) =>
      entry({ id: `k${index}`, ip: `10.0.0.${index + 1}` })
    )
    entries[0] = null
    entries[12] = entry({ id: '', ip: '10.0.0.13' })

    const config = normalize({ machines: entries })

    // The dropped entry at position 0 still consumes its position, so the id
    // records where in the file the entry actually was.
    expect(config.machines.at(-1)?.id).toBe('mlegacy-c')
  })

  it('keeps a port only when it is a whole number inside 1..65535 and falls back to 623 otherwise', () => {
    const ports: unknown[] = [623, 664, '664', 1, 65535, 0, -1, 65536, 623.5, 'ipmi', null, undefined, {}]

    const config = normalize({
      machines: ports.map((port, index) => entry({ id: `p${index}`, port }))
    })

    expect(config.machines.map((item) => item.port)).toEqual([
      623, 664, 664, 1, 65535, 623, 623, 623, 623, 623, 623, 623, 623
    ])
  })

  it('falls back to a legacy revision built from the id and to the ip as a name', () => {
    const config = normalize({
      machines: [
        entry({ id: 'm9', revision: '', name: '   ', ip: '10.0.0.7', note: '  ' }),
        entry({ id: '', revision: undefined, name: undefined, ip: '10.0.0.8', note: '  spare psu  ' })
      ]
    })

    expect(config.machines[0].revision).toBe('legacy-m9')
    expect(config.machines[0].name).toBe('10.0.0.7')
    // A whitespace-only note is no note, so the row does not grow an empty line.
    expect(config.machines[0].note).toBeUndefined()

    expect(config.machines[1].id).toBe('mlegacy-1')
    expect(config.machines[1].revision).toBe('legacy-mlegacy-1')
    expect(config.machines[1].name).toBe('10.0.0.8')
    expect(config.machines[1].note).toBe('spare psu')
  })

  it('trims the address and the username, so a stray space cannot make a row unreachable', () => {
    const config = normalize({ machines: [entry({ ip: ' 10.0.0.5 ', username: ' root ' })] })

    expect(config.machines[0].ip).toBe('10.0.0.5')
    expect(config.machines[0].username).toBe('root')
    // The password is taken verbatim: a BMC password may legitimately end in a space.
    expect(normalize({ machines: [entry({ password: ' calvin ' })] }).machines[0].password).toBe(' calvin ')
  })
})

describe('normalize: the MAX_MACHINES ceiling', () => {
  it('keeps the first 64 entries of an oversized list and reports the remainder as dropped', () => {
    expect(MAX_MACHINES).toBe(64)
    const doc = docOf(70)

    const config = normalize(doc)

    expect(config.machines).toHaveLength(64)
    expect(config.machines[0].id).toBe('m0')
    expect(config.machines.at(-1)?.id).toBe('m63')
    // The count is what the "some machines were ignored" line quotes, so it has
    // to describe the file on disk, not the truncated list.
    expect(droppedMachineCount(doc)).toBe(6)
  })

  it('reports nothing dropped for a list inside the limit or for a document with no list', () => {
    expect(droppedMachineCount(docOf(3))).toBe(0)
    expect(droppedMachineCount(docOf(64))).toBe(0)
    expect(droppedMachineCount(null)).toBe(0)
    expect(droppedMachineCount('corrupt')).toBe(0)
    expect(droppedMachineCount({ machines: 'not a list' })).toBe(0)
  })

  it('counts only usable entries as dropped, matching what normalize would have kept', () => {
    const doc = docOf(66)
    const machines: unknown[] = [...doc.machines]
    machines[2] = null
    machines[4] = entry({ id: 'no-username', username: '' })

    // 66 entries, 2 of them unusable: 64 usable, so nothing is actually lost.
    expect(droppedMachineCount({ machines })).toBe(0)
    expect(normalize({ machines }).machines).toHaveLength(64)
  })
})

describe('normalize: the tunables', () => {
  it('clamps out-of-range values to their limits and truncates the ones that are not whole', () => {
    const config = normalize({
      machines: [],
      settings: { sweepConcurrency: 99, sensorEverySweeps: -4, selFetchCount: '2500', identifySeconds: 12.9 }
    })

    expect(config.settings).toEqual({
      sweepConcurrency: 16,
      sensorEverySweeps: 0,
      selFetchCount: 1000,
      identifySeconds: 12
    })
  })

  it('falls back to the default for a value it cannot read at all', () => {
    const config = normalize({
      settings: {
        sweepConcurrency: 'four',
        sensorEverySweeps: undefined,
        selFetchCount: {},
        identifySeconds: Number.NaN
      }
    })

    expect(config.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('uses the defaults when settings is missing or is not an object', () => {
    expect(normalize({ machines: [] }).settings).toEqual(DEFAULT_SETTINGS)
    expect(normalize({ settings: null }).settings).toEqual(DEFAULT_SETTINGS)
    expect(normalize({ settings: 'nonsense' }).settings).toEqual(DEFAULT_SETTINGS)
    expect(normalize({ settings: [] }).settings).toEqual(DEFAULT_SETTINGS)
  })

  it('keeps sensorEverySweeps: 0, which is the user turning sensor health off rather than a missing value', () => {
    // 0 is inside the range and is the only way to ask for power-only health.
    // Treating it as falsy would quietly turn sensor folding back on.
    expect(normalize({ settings: { sensorEverySweeps: 0 } }).settings.sensorEverySweeps).toBe(0)
    expect(normalize({ settings: { sensorEverySweeps: 0 } }).settings.sweepConcurrency).toBe(
      DEFAULT_SETTINGS.sweepConcurrency
    )
    expect(normalize({ settings: { identifySeconds: 0 } }).settings.identifySeconds).toBe(0)
  })
})

describe('clampSetting', () => {
  it('truncates towards zero rather than rounding, so a value never grows past what was typed', () => {
    expect(clampSetting('sweepConcurrency', 3.9)).toBe(3)
    expect(clampSetting('selFetchCount', 100.999)).toBe(100)
    expect(clampSetting('identifySeconds', 15.5)).toBe(15)
  })

  it('clamps both ends of every documented range', () => {
    expect(clampSetting('sweepConcurrency', 0)).toBe(SETTING_LIMITS.sweepConcurrency.min)
    expect(clampSetting('sweepConcurrency', 1000)).toBe(SETTING_LIMITS.sweepConcurrency.max)
    expect(clampSetting('sensorEverySweeps', -1)).toBe(SETTING_LIMITS.sensorEverySweeps.min)
    expect(clampSetting('sensorEverySweeps', 21)).toBe(SETTING_LIMITS.sensorEverySweeps.max)
    expect(clampSetting('selFetchCount', 9)).toBe(SETTING_LIMITS.selFetchCount.min)
    expect(clampSetting('selFetchCount', 1001)).toBe(SETTING_LIMITS.selFetchCount.max)
    expect(clampSetting('identifySeconds', -1)).toBe(SETTING_LIMITS.identifySeconds.min)
    expect(clampSetting('identifySeconds', 256)).toBe(SETTING_LIMITS.identifySeconds.max)
  })

  it('reads a numeric string, because a hand-edited JSON file often quotes its numbers', () => {
    expect(clampSetting('selFetchCount', '250')).toBe(250)
    expect(clampSetting('sweepConcurrency', ' 8 ')).toBe(8)
  })

  it('returns the default for anything that is not a finite number', () => {
    const keys = Object.keys(SETTING_LIMITS) as Array<keyof BmcSettings>
    expect(keys).toHaveLength(4)
    for (const key of keys) {
      expect(clampSetting(key, undefined), key).toBe(DEFAULT_SETTINGS[key])
      expect(clampSetting(key, 'abc'), key).toBe(DEFAULT_SETTINGS[key])
      expect(clampSetting(key, Number.NaN), key).toBe(DEFAULT_SETTINGS[key])
      expect(clampSetting(key, Number.POSITIVE_INFINITY), key).toBe(DEFAULT_SETTINGS[key])
      expect(clampSetting(key, { value: 4 }), key).toBe(DEFAULT_SETTINGS[key])
    }
  })
})

describe('machineFingerprint', () => {
  it('is identical for two machines that are field-for-field the same', () => {
    expect(machineFingerprint(machine())).toBe(machineFingerprint(machine()))
    // An absent note and an empty one describe the same machine.
    expect(machineFingerprint(machine({ note: undefined }))).toBe(machineFingerprint(machine()))
  })

  it('changes when enabled flips, which is what discards an in-flight reading for a just-parked machine', () => {
    // Without `enabled` in here, a sweep that was already talking to the BMC
    // would land its answer on a card the user has just told us to stop asking.
    expect(machineFingerprint(machine({ enabled: false }))).not.toBe(machineFingerprint(machine()))
  })

  it('changes when any other field a reading depends on changes', () => {
    const base = machineFingerprint(machine())
    const edits: Array<Partial<BmcMachine>> = [
      { id: 'm2' },
      { revision: 'r2' },
      { name: 'Rack B iLO' },
      { ip: '10.0.0.6' },
      { port: 664 },
      { username: 'Administrator' },
      { enabled: false },
      { note: 'spare psu' }
    ]

    for (const edit of edits) {
      expect(machineFingerprint(machine(edit)), JSON.stringify(edit)).not.toBe(base)
    }
  })

  it('ignores the legacy password, so migrating one does not invalidate the fleet', () => {
    // The password left this document in version 3 and the fingerprint went
    // with it. Keeping it in would have made `migratePlaintext` - which deletes
    // the field from every machine at once - look like an edit to every entry:
    // every cached reading discarded, every in-flight sweep result thrown away,
    // and every drawer refusing to answer until the next pass, all for a change
    // no BMC could possibly notice.
    expect(machineFingerprint(machine({ password: 'hunter2' }))).toBe(machineFingerprint(machine()))
    expect(machineFingerprint(machine({ password: undefined }))).toBe(machineFingerprint(machine()))
  })
})

describe('machineAddress', () => {
  it('hides the standard IPMI port and shows any other one', () => {
    expect(machineAddress({ ip: '10.0.0.5', port: 623 })).toBe('10.0.0.5')
    expect(machineAddress({ ip: '10.0.0.5', port: 664 })).toBe('10.0.0.5:664')
    expect(machineAddress(machine({ port: 16_623 }))).toBe('10.0.0.5:16623')
  })
})

describe('ConfigStore over a version 1 document', () => {
  const answer = () => ({ stdout: '', stderr: '', code: 0 })

  it('exposes version 2 defaults for a document that predates them, without writing the file', () => {
    const config = sharedModuleConfig(clone(V1_DOCUMENT))
    const harness = moduleHarness('bmc', answer, { config })
    const store = new ConfigStore(harness.ctx)

    const doc = store.read()

    expect(doc.version).toBe(2)
    expect(doc.hintsOn).toBe(true)
    expect(doc.machines.map((item) => item.enabled)).toEqual([true, true])
    expect(store.settings()).toEqual(DEFAULT_SETTINGS)
    // The file itself is still the version 1 one an older module can read.
    expect(config.get()).toEqual(V1_DOCUMENT)
    store.dispose()
  })

  it('serves settings() from the cache instead of re-validating the machine list on every sweep', () => {
    const inner = sharedModuleConfig(clone(V1_DOCUMENT))
    let reads = 0
    const config: SharedModuleConfig = {
      ...inner,
      get: () => {
        reads++
        return inner.get()
      }
    }
    const harness = moduleHarness('bmc', answer, { config })
    const store = new ConfigStore(harness.ctx)

    const settings = store.settings()
    expect(store.settings()).toBe(settings)
    expect(store.settings()).toBe(settings)

    expect(reads).toBe(1)
    store.dispose()
  })
})
