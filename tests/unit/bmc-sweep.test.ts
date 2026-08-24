import { describe, expect, it, vi } from 'vitest'
import { moduleHarness } from '../helpers/module-harness'
import activateBmc from '../../bmc/main/index'
import { buildMachinesPayload, type MachineRuntimeState } from '../../bmc/main/sweep'
import type { BmcConfig } from '../../bmc/main/config'

function configWith(machine: Partial<BmcConfig['machines'][number]> = {}): BmcConfig {
  return {
    version: 1,
    machines: [
      {
        id: 'm1',
        revision: 'r1',
        name: 'Server 1',
        ip: '10.0.0.5',
        port: 623,
        username: 'admin',
        password: 'secret',
        ...machine
      }
    ]
  }
}

describe('buildMachinesPayload: "seen" chip', () => {
  it('reports the last-seen time as a raw epoch + ValueFormat instead of a pre-formatted string', () => {
    const lastSeen = Date.UTC(2026, 0, 15, 13, 45, 30)
    const states = new Map<string, MachineRuntimeState>([
      ['m1', { revision: 'r1', power: 'on', reach: 'ok', lastSeen }]
    ])

    const payload = buildMachinesPayload(configWith(), states)

    // The chip carries the raw value for StatusCardsBlockView (toChips) to
    // format client-side via formatBlockValue('time', ...) - not a string
    // this server already rendered in its own locale/timezone.
    expect(payload.machines[0].chips).toContainEqual({ label: 'seen', value: lastSeen, format: 'time' })
  })

  it('falls back to a plain, unformatted "never seen" chip when nothing has been seen yet', () => {
    const payload = buildMachinesPayload(configWith(), new Map())

    expect(payload.machines[0].chips).toContainEqual({ label: 'never seen' })
    const chip = payload.machines[0].chips.find((c) => c.label === 'never seen')
    expect(chip).not.toHaveProperty('format')
    expect(chip).not.toHaveProperty('value')
  })
})

describe('primary election for the automatic sweep', () => {
  it('a non-primary instance runs neither the ipmitool probe nor the sweep poller', () => {
    const harness = moduleHarness('bmc', () => ({ stdout: 'ipmitool version 1.8.18\n', stderr: '', code: 0 }), {
      isPrimaryInstance: false
    })
    const lifecycle = activateBmc(harness.ctx)
    lifecycle.applyPollers?.()
    expect(harness.exec).not.toHaveBeenCalled()
    expect(harness.pollers[0]?.start).not.toHaveBeenCalled()
  })

  it('the primary instance probes and starts the sweep poller at the slow interval', async () => {
    const harness = moduleHarness('bmc', () => ({ stdout: 'ipmitool version 1.8.18\n', stderr: '', code: 0 }), {
      isPrimaryInstance: true
    })
    const lifecycle = activateBmc(harness.ctx)
    lifecycle.applyPollers?.()
    await vi.waitFor(() => expect(harness.pollers[0]?.start).toHaveBeenCalledWith(60_000))
    expect(harness.exec).toHaveBeenCalled()
  })
})
