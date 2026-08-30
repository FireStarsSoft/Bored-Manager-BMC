import { describe, expect, it } from 'vitest'
import { moduleHarness } from '../helpers/module-harness'
import {
  buildMachinesPayload,
  Incidents,
  INCIDENT_SET,
  type MachineRuntimeState,
  type MachinesPayload
} from '../../bmc/main/sweep'
import { defaultSettings, normalize, type BmcConfig, type BmcMachine } from '../../bmc/main/store'

/**
 * What is worth writing down, and - much more of the work - what is not.
 *
 * A sweep runs every minute against up to sixty-four machines. If this
 * recorded a state rather than a change, six months of it would be millions of
 * rows saying "still fine", and the one row somebody actually needs would be
 * unfindable inside them. Almost every case below is about something that must
 * NOT produce a row.
 */

const T0 = Date.UTC(2026, 7, 30, 9, 0, 0)

function doc(machines: ReadonlyArray<Partial<BmcMachine>>): BmcConfig {
  return normalize({
    version: 3,
    hintsOn: true,
    settings: defaultSettings(),
    machines: machines.map((entry, index) => ({
      id: `m${index + 1}`,
      revision: `r${index + 1}`,
      name: `Server ${index + 1}`,
      ip: `10.0.0.${index + 5}`,
      port: 623,
      username: 'admin',
      enabled: true,
      ...entry
    }))
  })
}

function state(partial: Partial<MachineRuntimeState> = {}): MachineRuntimeState {
  return {
    revision: 'r1',
    power: 'on',
    reach: 'ok',
    lastSeen: T0,
    sensors: null,
    draw: null,
    clock: null,
    ...partial
  }
}

/** One machine, in whatever condition, swept at `t`. */
function sweep(
  condition: Partial<MachineRuntimeState> | 'unchecked' | 'parked',
  t = T0
): MachinesPayload {
  if (condition === 'parked') {
    return buildMachinesPayload(doc([{ enabled: false }]), new Map(), t)
  }
  if (condition === 'unchecked') {
    return buildMachinesPayload(doc([{}]), new Map(), t)
  }
  return buildMachinesPayload(
    doc([{}]),
    new Map([['m1', state({ ...condition, revision: 'r1' })]]),
    t
  )
}

function rig(): { incidents: Incidents; rows: () => Record<string, unknown>[] } {
  const harness = moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 0 }), {
    recordSets: [INCIDENT_SET]
  })
  return {
    incidents: new Incidents(harness.ctx),
    rows: () => harness.records.get(INCIDENT_SET) ?? []
  }
}

/** Let the detached append settle - a sweep never waits on the log. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('what does not get written down', () => {
  it('writes nothing for a machine it is seeing for the first time', async () => {
    // Otherwise every machine produces a row on the first sweep after every
    // restart, and the log fills with "this machine exists".
    const r = rig()

    r.incidents.observe(sweep({ power: 'on' }))
    await settle()

    expect(r.rows()).toEqual([])
  })

  it('writes nothing while a machine stays as it was, however many sweeps that is', async () => {
    // The case that decides whether six months of this is affordable: a fleet
    // behaving itself has to cost nothing at all.
    const r = rig()
    r.incidents.observe(sweep({ power: 'on' }, T0))

    for (let i = 1; i < 60; i++) r.incidents.observe(sweep({ power: 'on' }, T0 + i * 60_000))
    await settle()

    expect(r.rows()).toEqual([])
  })

  it('writes nothing for a machine that has not been checked yet', async () => {
    // Not a state a machine was in - the absence of a reading. Recording it
    // would put a row in the log every time the app reconnected.
    const r = rig()

    r.incidents.observe(sweep('unchecked', T0))
    r.incidents.observe(sweep({ power: 'on' }, T0 + 60_000))
    await settle()

    expect(r.rows()).toEqual([])
  })

  it('writes nothing when a machine is parked, and treats resuming it as a first sighting', async () => {
    const r = rig()
    r.incidents.observe(sweep({ power: 'on' }, T0))

    r.incidents.observe(sweep('parked', T0 + 60_000))
    r.incidents.observe(sweep({ power: 'on' }, T0 + 120_000))
    await settle()

    expect(r.rows()).toEqual([])
  })
})

describe('what does', () => {
  it('records a machine going critical, with what it looked like at the time', async () => {
    const r = rig()
    r.incidents.observe(sweep({ power: 'on' }, T0))

    r.incidents.observe(sweep({ power: null, reach: 'timeout' }, T0 + 60_000))
    await settle()

    expect(r.rows()).toHaveLength(1)
    expect(r.rows()[0]).toMatchObject({
      t: T0 + 60_000,
      key: 'm1',
      machine: 'Server 1',
      from: 'ok',
      to: 'bad'
    })
    // The summary at the moment it changed, so a row explains itself six
    // months later without anybody reconstructing the fleet around it.
    expect(String(r.rows()[0].detail)).toMatch(/answer|unreachable|no/i)
  })

  it('records the recovery as well, so a row is never the last word', async () => {
    const r = rig()
    r.incidents.observe(sweep({ power: 'on' }, T0))
    r.incidents.observe(sweep({ power: null, reach: 'timeout' }, T0 + 60_000))

    r.incidents.observe(sweep({ power: 'on' }, T0 + 120_000))
    await settle()

    expect(r.rows()).toHaveLength(2)
    expect(r.rows()[1]).toMatchObject({ from: 'bad', to: 'ok' })
  })

  it('keys every row by machine, which is what lets one machine be asked about on its own', async () => {
    const r = rig()
    const two = (first: Partial<MachineRuntimeState>, second: Partial<MachineRuntimeState>, t: number) =>
      buildMachinesPayload(
        doc([{}, {}]),
        new Map([
          ['m1', state({ ...first, revision: 'r1' })],
          ['m2', state({ ...second, revision: 'r2' })]
        ]),
        t
      )

    r.incidents.observe(two({ power: 'on' }, { power: 'on' }, T0))
    r.incidents.observe(two({ power: 'on' }, { power: null, reach: 'auth' }, T0 + 60_000))
    await settle()

    expect(r.rows()).toHaveLength(1)
    expect(r.rows()[0].key).toBe('m2')
  })

  it('records a warning as its own change, not only the critical ones', async () => {
    const r = rig()
    r.incidents.observe(sweep({ power: 'on' }, T0))

    r.incidents.observe(sweep({ power: null, reach: 'auth' }, T0 + 60_000))
    await settle()

    expect(r.rows()).toHaveLength(1)
    expect(r.rows()[0]).toMatchObject({ from: 'ok', to: 'warn' })
  })
})

describe('reading it back, and surviving it not being readable', () => {
  it('answers the newest transitions first, with an id a table can key on', async () => {
    const r = rig()
    r.incidents.observe(sweep({ power: 'on' }, T0))
    r.incidents.observe(sweep({ power: null, reach: 'timeout' }, T0 + 60_000))
    r.incidents.observe(sweep({ power: 'on' }, T0 + 120_000))
    await settle()

    const recent = await r.incidents.recent()

    expect(recent.map((row) => row.t)).toEqual([T0 + 120_000, T0 + 60_000])
    expect(new Set(recent.map((row) => row.id)).size).toBe(recent.length)
  })

  it('answers nothing rather than throwing when the log cannot be read', async () => {
    // A store that will not answer is not worth an error page: the fleet view
    // is what matters and it is unaffected.
    const harness = moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 0 }))
    const incidents = new Incidents(harness.ctx)

    await expect(incidents.recent()).resolves.toEqual([])
  })

  it('never lets a failed write take a sweep down with it', async () => {
    // The append is detached on purpose: a sweep must not fail, or wait,
    // because a log could not be written.
    const harness = moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 0 }))
    const incidents = new Incidents(harness.ctx)

    incidents.observe(sweep({ power: 'on' }, T0))
    expect(() => incidents.observe(sweep({ power: null, reach: 'timeout' }, T0 + 60_000))).not.toThrow()
    await settle()
  })

  it('starts over after a reset, because the next sweep is a first look', async () => {
    const r = rig()
    r.incidents.observe(sweep({ power: 'on' }, T0))

    r.incidents.reset()
    r.incidents.observe(sweep({ power: null, reach: 'timeout' }, T0 + 60_000))
    await settle()

    expect(r.rows()).toEqual([])
  })
})
