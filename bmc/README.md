# BMC

Manage server mainboards out of band from Bored Manager through IPMI 2.0 over LAN. The module is vendor-neutral and is intended for boards such as the Supermicro H11DSI and Gigabyte MZ72-HB2.

## Installing

This module is not part of the app download. Install it from **Settings →
Modules**, by any of:

- **Official list** - pick *BMC* from the list the app ships;
- **GitHub repo** - `FireStarsSoft/Bored-Manager-BMC`, which installs the
  latest release;
- **From file** - the `bmc-<version>.zip` attached to a
  [release](https://github.com/FireStarsSoft/Bored-Manager-BMC/releases).

It needs Bored Manager **0.3.2** or newer, and installs switched off; enable
it in the same place. Source, issues and changelog live in
[FireStarsSoft/Bored-Manager-BMC](https://github.com/FireStarsSoft/Bored-Manager-BMC).

## What it adds

| Where | What |
|---|---|
| Sidebar → BMC → Management | One status card per configured BMC. Open a card to inspect the controller, control chassis power, select a boot device, blink the UID LED, read sensors, and inspect or clear the system event log. Below the cards, **Fleet power over time** charts the same counts the sweep has been recording all along. |
| Sidebar → BMC → Module settings | Add, test, edit, and remove BMC addresses and credentials. |
| Overview cards | **BMC machines** (off by default): a donut of powered-on, powered-off, authentication-failed, unreachable, and not-yet-checked machines. |
| History | `bmc`: powered-on, powered-off, authentication-failed, and unreachable machine counts. |

The module is disabled by default. Enable it in Settings → Modules before using its pages.

## Requirements

The machine Bored Manager is connected to acts as the management station. It needs:

- `ipmitool` installed and available in `PATH`;
- network access to every configured BMC, normally UDP port 623;
- IPMI over LAN enabled on each BMC;
- an IPMI account with enough privilege for the operations you intend to use.

On Debian or Ubuntu install the `ipmitool` package with `apt`. On Fedora, RHEL, or compatible systems install it with `dnf`.

For Supermicro boards, check the IPMI settings in the BMC web interface. For Gigabyte boards using MegaRAC, check the corresponding management-protocol settings. Menu names vary by firmware revision. The module reports a missing local `ipmitool` explicitly rather than presenting empty data.

## Credentials are stored in clear text

Every configured password is written to:

`data/user-settings/module-config/bmc.json`

That JSON document is **not encrypted**. The module API only offers `ctx.configSet`, and the app's secret service is not exposed to modules. Protect the Bored Manager data directory and use a dedicated, least-privilege BMC account.

Passwords are never returned to the renderer, placed in a stream payload, or included in the `ipmitool` command line. The password is supplied over standard input and exposed only to the child command through the temporary `IPMI_PASSWORD` environment variable used by `ipmitool -E`.

## Status colours

| Colour | Meaning |
|---|---|
| Green | The BMC answered and chassis power is on. |
| Grey | The BMC answered and chassis power is off, or it has not been checked yet. |
| Amber | The BMC answered but rejected the credentials or privilege. |
| Red | The BMC could not be reached or returned another command error. |

## Controls

The drawer for a machine provides:

- power on;
- ACPI soft shutdown;
- immediate power off;
- power cycle;
- hard reset;
- one-time or persistent boot-device selection;
- UID/chassis-identify LED timing;
- sensor data records;
- the latest 100 system event log entries, with an explicit destructive confirmation before clearing them.

Hard power operations and event-log clearing always require confirmation in the UI.

## Polling

The slow `bmc` interval controls network sweeps. A sweep reads only `chassis power status`, with at most four BMC requests in flight at once. Management details, sensors, and event-log rows are fetched only while their drawer is open and are cached briefly to avoid turning the renderer's fast refresh into repeated network traffic.

The **Refresh now** button performs an immediate capability check and sweep. A successful power action also refreshes that one machine immediately.

The BMC list belongs to the module, not to whichever machine is acting as the management station - connect a second machine with this module enabled and it reaches the *same* endpoints. So the automatic sweep does not run twice against them, only one connected machine's instance runs it: whichever has this module's tab open, or the one that connected first if none does. **Refresh now** always runs, from whichever machine is open.

## Limitations

- IPMI 2.0 `lanplus` is the only transport.
- Vendor-specific OEM commands are not used.
- Serial over LAN is intentionally not exposed. A JSON `terminal` block would place credentials in a visible command template; a future implementation needs a safe credential-aware streaming API.
- Sensor and event-log wording comes from each BMC firmware. The module preserves unrecognised entries instead of guessing vendor-specific semantics.

## Files

| File | Purpose |
|---|---|
| `main/index.ts` | Module activation, RPC handlers, and lifecycle. |
| `main/config.ts` | Persistent machine definitions and credentials. |
| `main/ipmi.ts` | Safe `ipmitool` command construction and execution. |
| `main/parse.ts` | Parsers for power, sensors, event log, and controller details. |
| `main/probe.ts` | Detects `ipmitool` on the connected machine. |
| `main/sweep.ts` | Bounded-concurrency power sweep and published status payloads. |
| `main/queries.ts` | Cached details, sensor, and event-log queries. |
| `main/actions.ts` | Power, boot-device, identify, and event-log actions. |
| `main/machines.ts` | Check-before-apply settings editor and connection tests. |
