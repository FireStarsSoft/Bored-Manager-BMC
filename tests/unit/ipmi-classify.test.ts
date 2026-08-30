import { describe, expect, it } from 'vitest'
import {
  classifyIpmiFailure,
  failureLabel,
  failureMessage,
  IPMI_FAILURES,
  type IpmiFailure
} from '../../bmc/main/ipmi'

/**
 * What ipmitool printed, and where it sends the person reading the card.
 *
 * Every string below is a real ipmitool/lanplus stderr line rather than an
 * invented one: the classifier is only worth anything if it recognises the
 * text the tool actually emits, and these are the four states a user acts on
 * differently (wrong password, wrong name, nothing listening, nothing there).
 */

interface ClassifyCase {
  /** Reads as the `it()` name, so a failure says which real-world case broke. */
  name: string
  message: string
  code?: number
  expected: IpmiFailure
}

const CASES: readonly ClassifyCase[] = [
  {
    name: 'silence on UDP 623 - the RMCP+ session never opened - is a reachability problem',
    message: 'Error: Unable to establish IPMI v2 / RMCP+ session',
    expected: 'unreachable'
  },
  {
    name: 'a rejected role in the open-session response is a credentials problem, not a network one',
    message: 'Error in open session response message : invalid role',
    expected: 'auth'
  },
  {
    name: 'a RAKP 2 rejection names the account, so it is a credentials problem',
    message: 'Error: RAKP 2 message indicates an error : unauthorized name',
    expected: 'auth'
  },
  {
    name: "ipmitool's own address-lookup failure is a name problem",
    message: 'Address lookup for bmc01.lan failed',
    expected: 'dns'
  },
  {
    name: "the resolver's wording for the same thing is also a name problem",
    message: 'ipmitool: getaddrinfo: bmc01.lan: Name or service not known',
    expected: 'dns'
  },
  {
    name: 'something answering and refusing means IPMI over LAN is off or the port is wrong',
    message: 'Error: Unable to send RMCP+ message: Connection refused',
    expected: 'refused'
  },
  {
    // The app wraps every module command in timeout(1), which kills the child
    // and prints nothing at all - the exit code is the only evidence there is.
    name: 'exit code 124 with no output at all is the app timeout wrapper, so: timeout',
    message: '',
    code: 124,
    expected: 'timeout'
  },
  {
    name: "ipmitool's own retries expiring is also a timeout",
    message: 'Get Device ID command failed: timeout period expired',
    expected: 'timeout'
  },
  {
    name: 'anything unrecognised stays a plain error rather than guessing at a cause',
    message: 'ipmitool: not found',
    expected: 'error'
  },
  {
    name: 'a local ipmitool complaint is a plain error, not a network diagnosis',
    message: 'Unable to open SDR for reading',
    expected: 'error'
  }
]

describe('classifyIpmiFailure: real ipmitool output', () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      expect(classifyIpmiFailure(testCase.message, testCase.code)).toBe(testCase.expected)
    })
  }
})

describe('classifyIpmiFailure: the order the patterns are tried in', () => {
  it('reports auth, not unreachable, when the BMC rejected the credentials and then dropped the session', () => {
    // ipmitool prints both lines for one bad password. The BMC plainly
    // answered, so sending somebody to look at cabling would be wrong.
    const stderr = [
      'Error: RAKP 2 message indicates an error : unauthorized name',
      'Error: Unable to establish IPMI v2 / RMCP+ session'
    ].join('\n')

    expect(classifyIpmiFailure(stderr)).toBe('auth')
  })

  it('reports auth even when the app timeout wrapper cut the command short afterwards', () => {
    // The exit code says "we ran out of patience", but the text already says
    // the BMC answered and said no - that is the actionable half.
    const stderr = 'Error: RAKP 2 message indicates an error : unauthorized name'

    expect(classifyIpmiFailure(stderr, 124)).toBe('auth')
  })

  it('reports dns, not unreachable, when a name failed to resolve and the session then failed', () => {
    // "Address lookup ... failed" is always followed by "Unable to establish",
    // so the unreachable patterns must not get to it first.
    const stderr = [
      'Address lookup for bmc01.lan failed',
      'Error: Unable to establish IPMI v2 / RMCP+ session'
    ].join('\n')

    expect(classifyIpmiFailure(stderr)).toBe('dns')
  })

  it('reports refused, not timeout, when a port unreachable arrives after the retries expired', () => {
    const stderr = [
      'Get Device ID command failed: timeout period expired',
      'Error: Unable to send RMCP+ message: Connection refused'
    ].join('\n')

    expect(classifyIpmiFailure(stderr)).toBe('refused')
  })
})

/**
 * The union and the array have to stay in step: if a member is added to
 * `IpmiFailure` without being added to `IPMI_FAILURES`, the message tables
 * below would never be checked for it. The record literal is the type-level
 * half of that (a new member fails to compile here), the assertion is the
 * value-level half.
 */
const EVERY_MEMBER: Readonly<Record<IpmiFailure, true>> = {
  unreachable: true,
  timeout: true,
  dns: true,
  auth: true,
  refused: true,
  error: true
}

describe('failure messages and labels cover every failure state', () => {
  it('IPMI_FAILURES lists every member of the IpmiFailure union exactly once', () => {
    expect([...IPMI_FAILURES].sort()).toEqual(Object.keys(EVERY_MEMBER).sort())
    expect(new Set(IPMI_FAILURES).size).toBe(IPMI_FAILURES.length)
  })

  for (const failure of IPMI_FAILURES) {
    it(`"${failure}" has a full sentence a person can act on, and a short label`, () => {
      const message = failureMessage(failure)
      expect(message.length).toBeGreaterThan(40)
      expect(message.endsWith('.')).toBe(true)

      const label = failureLabel(failure)
      expect(label.trim()).not.toBe('')
      expect(label.length).toBeLessThan(40)
    })
  }

  it('gives every state its own message and its own label, so two states never read alike', () => {
    const messages = IPMI_FAILURES.map(failureMessage)
    const labels = IPMI_FAILURES.map(failureLabel)

    expect(new Set(messages).size).toBe(IPMI_FAILURES.length)
    expect(new Set(labels).size).toBe(IPMI_FAILURES.length)
  })
})
