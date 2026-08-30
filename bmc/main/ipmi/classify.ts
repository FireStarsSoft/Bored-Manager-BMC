/**
 * Turning what ipmitool printed into a state a card can be painted with.
 *
 * The distinctions here are the ones a user acts on differently: a password
 * that is wrong is a settings problem, a name that does not resolve is a DNS
 * problem, and silence on UDP 623 is a firewall or a powered-down standby
 * rail. Collapsing them into one "error" - which is what this module did
 * before - tells somebody their rack is broken without telling them where to
 * look.
 */

export type IpmiFailure = 'unreachable' | 'timeout' | 'dns' | 'auth' | 'refused' | 'error'

/** Every member of the union, for the exhaustive message table and its test. */
export const IPMI_FAILURES: readonly IpmiFailure[] = [
  'unreachable',
  'timeout',
  'dns',
  'auth',
  'refused',
  'error'
]

/**
 * The exit code the app's own `timeout(1)` wrapper uses when it cuts a command
 * short. ipmitool's own `-N`/`-R` retries expire as a message instead, so both
 * paths have to be recognised.
 */
const TIMEOUT_EXIT_CODE = 124

/**
 * Order matters. Authentication is checked first because a BMC that rejects
 * RAKP has plainly answered - it is reachable, and reporting it as a network
 * fault would send somebody to the wrong place. Name resolution is checked
 * before the general unreachable patterns for the same reason: "Address
 * lookup failed" also matches "Unable to establish".
 */
export function classifyIpmiFailure(message: string, code?: number): IpmiFailure {
  // `invalid role` and `invalid name length` are how ipmitool reports an
  // account it cannot open a session as. They are matched by name rather than
  // by the "open session response" sentence that carries them, because that
  // same sentence also carries "insufficient resources for session" - a BMC
  // out of session slots, which is not a credentials problem. Missing them
  // mattered: ipmitool prints its own "Unable to establish" line straight
  // afterwards, so a too-low privilege level was being reported as a missing
  // network route and sending people to check cabling.
  if (
    /RAKP 2|invalid user\s?name|invalid role|invalid name length|Unauthorized|password|privilege|authentication/i.test(
      message
    )
  ) {
    return 'auth'
  }
  if (/Address lookup .* failed|Name or service not known|could not resolve|Temporary failure in name resolution/i.test(message)) {
    return 'dns'
  }
  if (/Connection refused|port unreachable|Destination unreachable/i.test(message)) {
    return 'refused'
  }
  if (code === TIMEOUT_EXIT_CODE) return 'timeout'
  if (/timed?\s*out|timeout period expired|Operation timed out/i.test(message)) {
    return 'timeout'
  }
  if (/Unable to establish|No route to host|Network is unreachable|Host is unreachable/i.test(message)) {
    return 'unreachable'
  }
  return 'error'
}
