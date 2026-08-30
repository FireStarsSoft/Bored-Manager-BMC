/**
 * What each failure means, written as something a user can act on.
 *
 * ipmitool's own text is kept alongside these (see `IpmiResult.message`) for
 * anybody who wants it, but it is written for whoever is debugging ipmitool,
 * not for whoever is standing in front of a rack wondering which of four
 * plausible things is wrong. These sentences name the likely causes in the
 * order they are usually true.
 */
import type { IpmiFailure } from './classify'

const MESSAGES: Readonly<Record<IpmiFailure, string>> = {
  auth: 'The BMC refused the saved credentials. Check the user name and password on the Module settings page, and that the account still exists on the BMC and is allowed to use IPMI over LAN.',
  dns: 'The BMC address could not be resolved to an IP. Check the spelling, or use the numeric address instead of a name.',
  refused: 'Something answered on that address and refused the connection. Either the port is wrong or IPMI over LAN is switched off in the BMC firmware.',
  timeout: 'The BMC did not answer before the time limit. It may be powered down along with its standby rail, or a firewall is dropping UDP traffic on its IPMI port.',
  unreachable: 'There is no route to the BMC from the connected machine. Check that it is on a network this machine can reach, and that the address is the management port rather than the operating system.',
  error: 'ipmitool could not complete the request. Its own message is shown alongside this and usually names the reason.'
}

/** A full sentence for a failure state; never an empty string. */
export function failureMessage(failure: IpmiFailure): string {
  return MESSAGES[failure]
}

/** The short label a chip or a status column uses for the same state. */
const LABELS: Readonly<Record<IpmiFailure, string>> = {
  auth: 'Auth failed',
  dns: 'Address not found',
  refused: 'Connection refused',
  timeout: 'No answer',
  unreachable: 'Unreachable',
  error: 'ipmitool failed'
}

export function failureLabel(failure: IpmiFailure): string {
  return LABELS[failure]
}
