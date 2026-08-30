/**
 * Whether this module can work here, said in a way a page can gate on.
 *
 * A single `problem` string cannot express the difference between "no machine
 * is connected yet", "we are still asking", and "ipmitool is not installed" -
 * and a page that renders the same empty state for all three teaches people
 * that the module is broken during the two seconds it is merely starting.
 */
import type { ModuleContext } from '@shared/modules'
import { probeManagementHost, unprobedFacts, type BmcProbeFacts } from '../probe'
import { INTERVAL_KEY, type Sweeper } from '../sweep'
import type { ConfigStore } from '../store'

export type ReadinessState = 'connecting' | 'checking' | 'ready' | 'attention' | 'blocked'

export interface BmcCapabilities {
  t: number
  connected: boolean
  probed: boolean
  /** The version, or a word saying why there is not one. */
  ipmitool: string
  problem: string | null
  state: ReadinessState
  stateLabel: string
  /** True when a sweep would actually reach something. */
  ready: boolean
}

const LABELS: Readonly<Record<ReadinessState, string>> = {
  connecting: 'Waiting for a connected machine',
  checking: 'Checking the connected machine',
  blocked: 'The connected machine cannot run ipmitool',
  attention: 'Nothing is being swept',
  ready: 'Ready'
}

function toolLabel(facts: BmcProbeFacts): string {
  if (facts.ipmitool) return facts.ipmitool
  if (!facts.probed) return 'checking'
  return 'not found'
}

/**
 * Pure, so the whole table can be tested without a context.
 *
 * `checking` covers a probe that threw as well as one that has not run: a
 * connection that hiccupped looks exactly like a machine without the tool if
 * both are flattened into "missing", and only one of them is worth retrying.
 */
export function buildReadiness(
  facts: BmcProbeFacts,
  machineCount: number,
  enabledCount: number
): BmcCapabilities {
  const base = {
    t: facts.t,
    connected: facts.connected,
    probed: facts.probed,
    ipmitool: toolLabel(facts)
  }

  if (!facts.connected) {
    return { ...base, problem: null, state: 'connecting', stateLabel: LABELS.connecting, ready: false }
  }
  if (!facts.probed) {
    return {
      ...base,
      problem: null,
      state: 'checking',
      stateLabel: facts.transportError ? `${LABELS.checking} - retrying` : LABELS.checking,
      ready: false
    }
  }
  if (facts.problem) {
    return { ...base, problem: facts.problem, state: 'blocked', stateLabel: LABELS.blocked, ready: false }
  }
  if (enabledCount === 0) {
    const stateLabel =
      machineCount === 0
        ? 'No BMC machines have been added yet'
        : 'Every saved machine is parked'
    // Not a problem: the tool is there and the module works. There is simply
    // nothing to ask, which a page should say rather than draw as zeroes.
    return { ...base, problem: null, state: 'attention', stateLabel, ready: true }
  }
  return { ...base, problem: null, state: 'ready', stateLabel: LABELS.ready, ready: true }
}

/**
 * Holds the last probe, re-runs it on demand, and decides when the automatic
 * sweep may run.
 */
export class CapabilityLatch {
  private facts: BmcProbeFacts = unprobedFacts(false)
  private latest: BmcCapabilities
  private flight: Promise<BmcProbeFacts> | null = null
  private generation = 0
  private stopped = false
  private appliedPollers: string | null = null

  constructor(
    private ctx: ModuleContext,
    private config: ConfigStore,
    private sweeper: Sweeper
  ) {
    this.latest = this.derive()
  }

  snapshot(): BmcCapabilities {
    return this.latest
  }

  /** True when the connected machine can run ipmitool at all. */
  async ensureReady(force = false): Promise<boolean> {
    const facts = await this.refresh(force)
    return facts.connected && facts.probed && !facts.problem
  }

  refresh(force = false): Promise<BmcProbeFacts> {
    if (!force && this.facts.probed && this.facts.connected) return Promise.resolve(this.facts)
    if (this.flight) return this.flight

    const generation = this.generation
    const pending = probeManagementHost(this.ctx)
      .then((next) => {
        if (this.stopped || generation !== this.generation) return next
        this.facts = next
        this.publish()
        if (next.problem) this.ctx.log(`bmc: ${next.problem}`)
        return next
      })
      .finally(() => {
        if (this.flight === pending) this.flight = null
      })
    this.flight = pending
    return pending
  }

  /** Re-derive and emit, e.g. after a machine was added, parked, or deleted. */
  publish(): BmcCapabilities {
    this.latest = this.derive()
    this.ctx.emit('capabilities', this.latest)
    return this.latest
  }

  /**
   * The sweep reaches BMC endpoints the user configured, not this instance's
   * own connected machine - only the elected primary runs it automatically,
   * so two connected machines do not both hammer the same endpoints. A manual
   * "sweep now" is unaffected.
   */
  applySweepPoller(): void {
    const seconds = Math.max(0, this.ctx.slowIntervalSec(INTERVAL_KEY))
    const primary = this.ctx.isPrimaryInstance
    const key = `${this.ctx.connected}|${seconds}|${primary}`
    if (key === this.appliedPollers) return
    this.appliedPollers = key
    this.sweeper.poller.stop()
    if (!this.ctx.connected || !primary) return

    void this.refresh(true).then(() => {
      if (this.stopped || !this.ctx.connected || this.appliedPollers !== key) return
      if (seconds > 0) this.sweeper.poller.start(seconds * 1000)
      else void this.sweeper.run()
    })
  }

  reset(): void {
    this.generation += 1
    this.flight = null
    this.appliedPollers = null
    this.facts = unprobedFacts(false)
    this.latest = this.derive()
  }

  dispose(): void {
    this.stopped = true
    this.generation += 1
    this.flight = null
  }

  private derive(): BmcCapabilities {
    const machines = this.config.read().machines
    return buildReadiness(
      this.facts,
      machines.length,
      machines.filter((machine) => machine.enabled).length
    )
  }
}
