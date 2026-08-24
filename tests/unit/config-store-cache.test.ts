import { describe, expect, it } from 'vitest'
import { moduleHarness, sharedModuleConfig, type SharedModuleConfig } from '../helpers/module-harness'
import { ConfigStore as BmcConfigStore } from '../../bmc/main/config'

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

    store.update((doc) => {
      doc.machines[0].name = 'Renamed'
    })

    expect(store.read().machines[0].name).toBe('Renamed')
    expect(reads()).toBe(1)
    store.dispose()
  })
})
