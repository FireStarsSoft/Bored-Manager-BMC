import { describe, expect, it } from 'vitest'
import { moduleHarness, type ModuleHarness } from '../helpers/module-harness'
import { unprobedFacts, type BmcProbeFacts } from '../../bmc/main/probe'
import {
  buildReadiness,
  createRuntime,
  type BmcCapabilities,
  type ReadinessState
} from '../../bmc/main/runtime'

/**
 * Readiness is the one thing every page of this module gates on, and the whole
 * point of it is that "no machine is connected", "we are still asking" and
 * "ipmitool is not installed" are three different answers. Flattening any two
 * of them into one empty state is what teaches people the module is broken
 * while it is merely starting, so the table below is exhaustive on purpose:
 * all five states, with the two that are easiest to confuse pinned by name.
 */

/** What the connected machine reported the last time it was asked. */
const PROBED_AT = Date.UTC(2026, 7, 29, 9, 0, 0)

/** A probe that answered with ipmitool present - the row every case below bends. */
function probed(over: Partial<BmcProbeFacts> = {}): BmcProbeFacts {
  return {
    t: PROBED_AT,
    connected: true,
    probed: true,
    ipmitool: '1.8.18',
    problem: null,
    transportError: null,
    ...over
  }
}

/** What `probeManagementHost` writes when the probe command printed `missing`. */
const MISSING_TOOL =
  'ipmitool is not installed on the connected machine - install it (apt install ipmitool / dnf install ipmitool) and press Look again'

interface ReadinessCase {
  name: string
  facts: BmcProbeFacts
  machines: number
  enabled: number
  state: ReadinessState
  ready: boolean
  problem: string | null
}

const CASES: ReadinessCase[] = [
  {
    name: 'no machine is connected yet',
    facts: unprobedFacts(false),
    machines: 2,
    enabled: 2,
    state: 'connecting',
    ready: false,
    problem: null
  },
  {
    name: 'connected, and the probe has not answered yet',
    facts: unprobedFacts(true),
    machines: 2,
    enabled: 2,
    state: 'checking',
    ready: false,
    problem: null
  },
  {
    name: 'connected, and the probe itself failed',
    facts: { ...unprobedFacts(true), transportError: 'Error: channel closed' },
    machines: 2,
    enabled: 2,
    state: 'checking',
    ready: false,
    problem: null
  },
  {
    name: 'probed, and the machine cannot run ipmitool',
    facts: probed({ ipmitool: '', problem: MISSING_TOOL }),
    machines: 2,
    enabled: 2,
    state: 'blocked',
    ready: false,
    problem: MISSING_TOOL
  },
  {
    name: 'probed, with nothing saved',
    facts: probed(),
    machines: 0,
    enabled: 0,
    state: 'attention',
    ready: true,
    problem: null
  },
  {
    name: 'probed, with every saved machine parked',
    facts: probed(),
    machines: 3,
    enabled: 0,
    state: 'attention',
    ready: true,
    problem: null
  },
  {
    name: 'probed, with one machine left enabled',
    facts: probed(),
    machines: 3,
    enabled: 1,
    state: 'ready',
    ready: true,
    problem: null
  }
]

describe('buildReadiness: the five states a page gates on', () => {
  for (const row of CASES) {
    it(`${row.name} reads as "${row.state}"`, () => {
      const caps = buildReadiness(row.facts, row.machines, row.enabled)

      expect(caps.state).toBe(row.state)
      expect(caps.ready).toBe(row.ready)
      expect(caps.problem).toBe(row.problem)
    })
  }

  it('covers every state in the union and gives each one a sentence a person can read', () => {
    const seen = new Set<ReadinessState>(CASES.map((row) => row.state))

    expect([...seen].sort()).toEqual(['attention', 'blocked', 'checking', 'connecting', 'ready'])
    for (const row of CASES) {
      const caps = buildReadiness(row.facts, row.machines, row.enabled)
      expect(caps.stateLabel.trim(), `${row.name} has no label`).not.toBe('')
    }
  })

  it('carries the probe timestamp and the connected/probed facts through untouched', () => {
    const caps = buildReadiness(probed(), 1, 1)

    expect(caps.t).toBe(PROBED_AT)
    expect(caps.connected).toBe(true)
    expect(caps.probed).toBe(true)
  })
})

describe('buildReadiness: a probe that has not answered', () => {
  it('does not accuse the connected machine of missing ipmitool', () => {
    // The page renders `problem` as "here is what is wrong with this host".
    // A probe that is still in the air knows nothing, so it must not put a
    // sentence there during the two seconds the module is merely starting.
    const caps = buildReadiness(unprobedFacts(true), 2, 2)

    expect(caps.problem).toBeNull()
    expect(caps.ipmitool).toBe('checking')
  })

  it('stays "checking" and says it is retrying when the probe threw rather than answered', () => {
    // A connection that hiccupped looks exactly like a machine without the
    // tool once both are flattened into "missing" - and only one of the two
    // is worth retrying, so the transport error must not become `blocked`.
    const hiccup = buildReadiness(
      { ...unprobedFacts(true), transportError: 'Error: channel closed' },
      2,
      2
    )
    const quiet = buildReadiness(unprobedFacts(true), 2, 2)

    expect(hiccup.state).toBe('checking')
    expect(hiccup.problem).toBeNull()
    expect(hiccup.stateLabel).toMatch(/retry/i)
    expect(quiet.stateLabel).not.toMatch(/retry/i)
  })
})

describe('buildReadiness: blocked and attention', () => {
  it('keeps the problem sentence the probe wrote rather than a state name', () => {
    const caps = buildReadiness(probed({ ipmitool: '', problem: MISSING_TOOL }), 2, 2)

    expect(caps.state).toBe('blocked')
    expect(caps.problem).toBe(MISSING_TOOL)
    expect(caps.ready).toBe(false)
  })

  it('tells "no machines saved" apart from "every saved machine is parked"', () => {
    // Both are "nothing is being swept", but the fix is different: one asks
    // for an address, the other asks for a switch to be flipped back on.
    const empty = buildReadiness(probed(), 0, 0)
    const parked = buildReadiness(probed(), 3, 0)

    expect(empty.state).toBe('attention')
    expect(parked.state).toBe('attention')
    expect(empty.stateLabel).not.toBe(parked.stateLabel)
    expect(empty.stateLabel).toMatch(/no bmc machines/i)
    expect(parked.stateLabel).toMatch(/parked/i)
  })

  it('still reports ready while it has nothing to ask, because nothing is wrong', () => {
    const caps = buildReadiness(probed(), 0, 0)

    expect(caps.ready).toBe(true)
    expect(caps.problem).toBeNull()
  })
})

describe('buildReadiness: the ipmitool display field', () => {
  it('shows the version once the probe found it', () => {
    expect(buildReadiness(probed({ ipmitool: '1.8.18' }), 1, 1).ipmitool).toBe('1.8.18')
  })

  it('shows "not found" only after a probe answered without one', () => {
    expect(buildReadiness(probed({ ipmitool: '', problem: MISSING_TOOL }), 1, 1).ipmitool).toBe(
      'not found'
    )
  })

  it('shows "checking" while no probe has answered', () => {
    expect(buildReadiness(unprobedFacts(true), 1, 1).ipmitool).toBe('checking')
    expect(buildReadiness(unprobedFacts(false), 1, 1).ipmitool).toBe('checking')
  })
})

/** Every `capabilities` payload the module pushed, oldest first. */
function capabilityEvents(emit: ModuleHarness['emit']): BmcCapabilities[] {
  return emit.mock.calls
    .filter((call) => call[0] === 'capabilities')
    .map((call) => call[1] as BmcCapabilities)
}

describe('CapabilityLatch against a live context', () => {
  it('refuses to sweep and emits a blocked capabilities payload when ipmitool is missing', async () => {
    // What the probe command prints on a machine without the tool - the
    // `else echo missing` half of `if command -v ipmitool ...`.
    const harness = moduleHarness('bmc', () => ({ stdout: 'missing\n', stderr: '', code: 0 }))
    const runtime = createRuntime(harness.ctx)

    const ready = await runtime.latch.ensureReady(true)

    expect(ready).toBe(false)
    expect(harness.exec.mock.calls[0]?.[0]).toContain('command -v ipmitool')

    const latest = capabilityEvents(harness.emit).at(-1)
    expect(latest?.state).toBe('blocked')
    expect(latest?.ipmitool).toBe('not found')
    expect(latest?.problem).toMatch(/ipmitool is not installed/)
    expect(runtime.latch.snapshot()).toEqual(latest)
    runtime.dispose()
  })

  it('emits a ready-to-work payload once the probe reports a version', async () => {
    const harness = moduleHarness('bmc', () => ({
      stdout: 'ipmitool version 1.8.18\n',
      stderr: '',
      code: 0
    }))
    const runtime = createRuntime(harness.ctx)

    const ready = await runtime.latch.ensureReady(true)

    expect(ready).toBe(true)
    const latest = capabilityEvents(harness.emit).at(-1)
    expect(latest?.ipmitool).toBe('1.8.18')
    // No config document in this harness, so there is nothing to sweep yet -
    // which is `attention`, not a problem with the connected machine.
    expect(latest?.state).toBe('attention')
    expect(latest?.problem).toBeNull()
    runtime.dispose()
  })
})
