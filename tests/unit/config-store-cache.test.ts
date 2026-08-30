import { describe, expect, it } from 'vitest'
import { moduleHarness, sharedModuleConfig, type SharedModuleConfig } from '../helpers/module-harness'
import { ConfigStore as BmcConfigStore, type BmcConfig, type BmcMachine } from '../../bmc/main/store'

/**
 * modules-fleet-bmc#12: the store re-read and re-validated its whole config
 * document on every call - several times per sweep for the BMC machine list.
 * It read it fresh for a reason (the document is shared by every connected
 * machine's instance of the module, so a stale copy could overwrite somebody
 * else's edit), which is what `onConfigChange` is for: keep the parsed
 * document until any instance writes.
 *
 * The OpenWRT store has the same shape and the same test, in its own
 * repository: FireStarsSoft/Bored-Manager-OpenWRT.
 */

function counting(seed: unknown): { config: SharedModuleConfig; reads: () => number } {
  const inner = sharedModuleConfig(seed)
  let reads = 0
  return {
    reads: () => reads,
    config: {
      ...inner,
      get: () => {
        reads++
        return inner.get()
      }
    }
  }
}

function bmcDoc(ip: string): unknown {
  return {
    version: 1,
    machines: [
      { id: 'm1', revision: 'r1', name: 'Chassis', ip, port: 623, username: 'admin', password: 'secret' }
    ]
  }
}

describe('BMC config store', () => {
  it('parses the document once and hands the same one back', () => {
    const { config, reads } = counting(bmcDoc('10.0.0.1'))
    const harness = moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 0 }), { config })
    const store = new BmcConfigStore(harness.ctx)

    expect(store.read().machines).toHaveLength(1)
    store.read()
    store.read()

    expect(reads()).toBe(1)
  })

  it('drops it the moment any instance writes, including one on another machine', () => {
    const { config, reads } = counting(bmcDoc('10.0.0.1'))
    const harness = moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 0 }), { config })
    const store = new BmcConfigStore(harness.ctx)
    expect(store.read().machines[0].ip).toBe('10.0.0.1')

    // What another connected machine's instance of this module writing looks
    // like from here.
    config.set(bmcDoc('10.0.0.9'))

    expect(store.read().machines[0].ip).toBe('10.0.0.9')
    expect(reads()).toBe(2)
  })

  it('keeps what it just wrote itself', () => {
    const { config, reads } = counting(bmcDoc('10.0.0.1'))
    const harness = moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 0 }), { config })
    const store = new BmcConfigStore(harness.ctx)
    store.read()

    store.update((doc: BmcConfig) => {
      doc.machines[0].name = 'Renamed'
    })

    expect(store.read().machines[0].name).toBe('Renamed')
    expect(reads()).toBe(1)
    store.dispose()
  })
})

/**
 * The other half of caching the document: a write that the host refuses.
 * `configSet` throws for real reasons - a document over the 512 KB config
 * grant, ENOSPC, EACCES, a read-only volume - and the store used to mutate the
 * cached document in place before offering it to the host. When the write
 * threw, the module went on serving and acting on a document that is not on
 * disk: the machine the user had just been told was NOT deleted was gone from
 * `machineRows`, the sweep stopped contacting it, and it reappeared at the next
 * restart.
 */

/**
 * A config whose writes can be made to fail the way the host's do. A refused
 * write leaves the stored value untouched and notifies nobody, which is what
 * the file on disk does when the write never lands.
 */
function refusingWrites(seed: unknown): {
  config: SharedModuleConfig
  writes: () => BmcConfig[]
  refuse: (on: boolean) => void
} {
  const inner = sharedModuleConfig(seed)
  const writes: BmcConfig[] = []
  let refusing = false
  return {
    writes: () => writes,
    refuse: (on) => {
      refusing = on
    },
    config: {
      ...inner,
      set: (value) => {
        if (refusing) throw new Error('bmc: config document is over the 512 KB limit')
        writes.push(value as BmcConfig)
        inner.set(value)
      }
    }
  }
}

/** Two machines, so that deleting one leaves something to assert about the other. */
function bmcPairDoc(): unknown {
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
        password: 'secret',
        enabled: true
      },
      {
        id: 'm2',
        revision: 'r2',
        name: 'Spare',
        ip: '10.0.0.2',
        port: 623,
        username: 'admin',
        password: 'spare-secret',
        enabled: true
      }
    ],
    settings: { sweepConcurrency: 2, sensorEverySweeps: 3, selFetchCount: 100, identifySeconds: 15 },
    hintsOn: true
  }
}

function storeOver(config: SharedModuleConfig): BmcConfigStore {
  const harness = moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 0 }), { config })
  return new BmcConfigStore(harness.ctx)
}

function ids(config: BmcConfig): string[] {
  return config.machines.map((machine) => machine.id)
}

function deleteSpare(doc: BmcConfig): void {
  doc.machines = doc.machines.filter((machine) => machine.id !== 'm2')
}

describe('BMC config store when the host refuses a write', () => {
  it('still serves what it wrote, and writes it once, when the host accepts the write', () => {
    const { config, writes } = refusingWrites(bmcPairDoc())
    const store = storeOver(config)

    store.update(deleteSpare)

    expect(ids(store.read())).toEqual(['m1'])
    expect(writes()).toHaveLength(1)
    expect(ids(writes()[0])).toEqual(['m1'])
    store.dispose()
  })

  it('reports the failure and goes on serving the machine the delete did not remove', () => {
    const { config, writes, refuse } = refusingWrites(bmcPairDoc())
    const store = storeOver(config)
    expect(store.read().machines).toHaveLength(2)
    refuse(true)

    expect(() => store.update(deleteSpare)).toThrow(/512 KB/)

    // The user has been told the delete failed, so the sweep and every row
    // must still see the machine that is still on disk.
    const served = store.read()
    expect(served.machines).toHaveLength(2)
    expect(ids(served)).toEqual(['m1', 'm2'])
    expect(writes()).toHaveLength(0)
    store.dispose()
  })

  it('applies no part of a mutation that touched several fields before the write failed', () => {
    const { config, refuse } = refusingWrites(bmcPairDoc())
    const store = storeOver(config)
    store.read()
    refuse(true)

    const added: BmcMachine = {
      id: 'm3',
      revision: 'r3',
      name: 'New',
      ip: '10.0.0.3',
      port: 623,
      username: 'admin',
      password: 'new-secret',
      enabled: true
    }
    expect(() =>
      store.update((doc: BmcConfig) => {
        doc.hintsOn = false
        doc.settings.sweepConcurrency = 16
        doc.machines[0].name = 'Renamed'
        doc.machines.push(added)
      })
    ).toThrow(/512 KB/)

    const served = store.read()
    expect(served.hintsOn).toBe(true)
    expect(served.settings.sweepConcurrency).toBe(2)
    expect(served.machines[0].name).toBe('Chassis')
    expect(ids(served)).toEqual(['m1', 'm2'])
    store.dispose()
  })

  it('starts the next update from the document on disk, not from the draft that failed', () => {
    const { config, writes, refuse } = refusingWrites(bmcPairDoc())
    const store = storeOver(config)
    refuse(true)
    expect(() => store.update(deleteSpare)).toThrow(/512 KB/)
    refuse(false)

    store.update((doc: BmcConfig) => {
      doc.machines[0].name = 'Renamed'
    })

    const served = store.read()
    expect(ids(served)).toEqual(['m1', 'm2'])
    expect(served.machines[0].name).toBe('Renamed')
    expect(writes()).toHaveLength(1)
    expect(ids(writes()[0])).toEqual(['m1', 'm2'])
    store.dispose()
  })

  it('keeps a nested machine intact when a failed update edited it, not just the top level', () => {
    const { config, refuse } = refusingWrites(bmcPairDoc())
    const store = storeOver(config)
    store.read()
    refuse(true)

    expect(() =>
      store.update((doc: BmcConfig) => {
        doc.machines[1].ip = '10.0.0.99'
        doc.machines[1].password = 'rotated'
      })
    ).toThrow(/512 KB/)

    // A shallow copy of the document would share this array with the cache and
    // leak both edits - the sweep would then talk to an address, and with a
    // password, that nothing ever stored.
    const spare = store.read().machines[1]
    expect(spare.ip).toBe('10.0.0.2')
    expect(spare.password).toBe('spare-secret')
    store.dispose()
  })
})
