/**
 * The settings table's rows.
 *
 * Two rules shape this file. The password is never in it - the renderer is
 * told whether one is set, never what it is. And no time is formatted here:
 * `lastTestAt` is raw epoch milliseconds for a `datetime` column to render in
 * the viewer's own locale, because a string built on the server bakes in the
 * server's timezone and reads as the wrong hour to anybody elsewhere.
 */
import type { ValueBadge } from '@shared/module-ui'
import { BADGE, badge } from '../badges'
import { machineAddress, type BmcMachine, type CredentialState } from '../store'
import type { MachineRuntimeState, StatePresentation } from '../sweep'

export interface TestResult {
  revision: string
  at: number
  ok: boolean
  message: string
}

export interface MachineRow extends Record<string, unknown> {
  id: string
  revision: string
  name: string
  ip: string
  port: number
  address: string
  username: string
  auth: string
  /** `saved` | `missing` | `unreadable`, for a spec that wants to act on it. */
  credential: CredentialState
  enabled: boolean
  enabledLabel: string
  note: string
  powerLabel: string
  lastTestAt: number | null
  lastTestResult: ValueBadge[]
  problem: string
}

export function testBadges(result: TestResult | undefined): ValueBadge[] {
  if (!result) return []
  return [result.ok ? badge('OK', BADGE.good) : badge('Failed', BADGE.bad)]
}

/** What the Credentials column says, without a password being read. */
const AUTH_LABEL: Readonly<Record<CredentialState, string>> = {
  saved: 'password saved',
  missing: 'no password',
  unreadable: 'enter it again'
}

export function buildRow(
  machine: BmcMachine,
  runtime: MachineRuntimeState | undefined,
  presentation: StatePresentation,
  tested: TestResult | undefined,
  credential: CredentialState
): MachineRow {
  return {
    id: machine.id,
    revision: machine.revision,
    name: machine.name,
    ip: machine.ip,
    port: machine.port,
    address: machineAddress(machine),
    username: machine.username,
    auth: AUTH_LABEL[credential],
    credential,
    enabled: machine.enabled,
    enabledLabel: machine.enabled ? 'Swept' : 'Parked',
    note: machine.note ?? '',
    powerLabel: presentation.powerLabel,
    lastTestAt: tested?.at ?? null,
    lastTestResult: testBadges(tested),
    problem: tested && !tested.ok ? tested.message : runtime?.lastError ?? ''
  }
}
