# BMC

Manage server mainboards out of band from Bored Manager through IPMI 2.0 over LAN, and watch their sensors. The module is vendor-neutral and is intended for boards such as the Supermicro H11DSI and Gigabyte MZ72-HB2.

## Installing

This module is not part of the app download. Install it from **Settings →
Modules**, by any of:

- **Official list** - pick *BMC* from the list the app ships;
- **GitHub repo** - `FireStarsSoft/Bored-Manager-BMC`, which installs the
  latest release;
- **From file** - the `bmc-<version>.zip` attached to a
  [release](https://github.com/FireStarsSoft/Bored-Manager-BMC/releases).

It needs Bored Manager **0.6.0** or newer - that is the release that gave
modules an encrypted place to keep credentials, and an attention signal a
module can ask for - and installs switched off; enable it in the same place. Source, issues and changelog live in
[FireStarsSoft/Bored-Manager-BMC](https://github.com/FireStarsSoft/Bored-Manager-BMC).

## What it adds

| Where | What |
|---|---|
| Sidebar → BMC → Management | **Fleet**: one status card per configured BMC, coloured by everything the module knows about it - power state *and* sensors. Open a card for its sensors, event log, chassis power, boot device, UID LED and controller details. **Attention**: every sensor across the whole fleet that is not ok, worst first, in one table. **Trends**: power states over the last hour and fleet sensor faults over the last six. **Bulk power**: tick several machines and act on all of them at once. |
| Sidebar → BMC → Module settings | **Machines**: add, test, edit, park and remove BMC addresses and credentials. **Behaviour**: the rules the sweep runs by. **Readiness**: what the connected machine can do. Everything here except the connection test works without ipmitool, so a fleet can be typed in while somebody installs it. |
| Overview cards | **BMC fleet health** (off by default): a health ring, a per-machine wall, and an attention meter that pulses while anything is critical. |
| History | `bmc`: powered-on, powered-off, authentication-failed and unreachable machine counts, fleet sensor warning and critical counts, and the watts drawn by the machines whose controllers report a draw. |
| Records | `incidents`: one row each time a machine changed state, kept for six months - the one thing here that outlives the metrics window and can answer "how long has this been happening". |

The module is disabled by default. Enable it in Settings → Modules before using its pages.

## Requirements

The machine Bored Manager is connected to acts as the management station. It needs:

- `ipmitool` installed and available in `PATH`;
- network access to every configured BMC, normally UDP port 623;
- IPMI over LAN enabled on each BMC;
- an IPMI account with enough privilege for the operations you intend to use.

On Debian or Ubuntu install the `ipmitool` package with `apt`. On Fedora, RHEL, or compatible systems install it with `dnf`.

For Supermicro boards, check the IPMI settings in the BMC web interface. For Gigabyte boards using MegaRAC, check the corresponding management-protocol settings. Menu names vary by firmware revision.

## Where the passwords are kept

In the app's own secret store, encrypted at rest with this install's key, under `data/module-data/bmc/secrets/`. They are **not** in this module's settings file, and a password is read back one at a time at the moment it is needed rather than held anywhere.

Nothing else ever sees one. A password is never returned to the browser, never put in a stream payload, and never placed on the `ipmitool` command line - it goes in over standard input and reaches the child only through the `IPMI_PASSWORD` environment variable that `ipmitool -E` reads, so it is not in the target's process list either. When you edit a machine it crosses the wire once, during the check, and the save that follows deliberately sends an empty field.

**Upgrading from 1.x moves them for you.** The first sweep after the update writes every saved password into the secret store and then rewrites the settings file without them. If anything goes wrong part-way the file is left exactly as it was, so the module keeps working and tries again next time.

**If `data/secret.key` is lost, the passwords are not recoverable.** Restoring a backup of `data/` without that file is the usual way it happens. The module can tell that case apart from "never set", so the Credentials column says *enter it again* for the rows affected instead of quietly failing to authenticate - which matters, because repeated bad credentials is how BMC accounts get locked.

Use a dedicated operator-level IPMI account per machine rather than the controller's administrator account, and keep the management network segment private.

## How a machine gets its colour

A card is green only when nothing the module knows about it is wrong. Sensor state and power state are folded together, worst wins:

| Colour | Meaning |
|---|---|
| Green | The BMC answered, chassis power is on, and no sensor is outside its thresholds. |
| Amber | A sensor is in a non-critical band (`nc`, `lnc`, `unc`), or the BMC rejected the saved credentials. |
| Red | A sensor is critical or non-recoverable (`cr`, `nr`, `lcr`, `ucr`, `lnr`, `unr`), or the BMC could not be reached, timed out, refused the connection, or did not resolve. |
| Grey | Chassis power is off, the machine is parked, or it has not been checked yet - none of which is a fault. |

The controller's clock is checked about once an hour. It is never folded into a machine's colour - a wrong clock means the hardware is fine and the log is what suffers - but it shows as a chip on the card and as a plain warning above the event log, because a controller running four hours out turns its whole log into something nobody can correlate, and nothing about that is visible until somebody tries.

Where a controller implements **DCMI**, the sweep also reads what the chassis is drawing and shows it on the card as a neutral chip - a fact, not a verdict, because nothing here knows what a given machine ought to be drawing. Plenty of boards do not implement it; the first refusal is remembered and that machine is never asked again. The Trends tab charts the fleet total over twelve hours, and the Overview card shows it only when at least one controller actually reported one, so an empty figure is never presented as "the rack draws nothing".

Severity comes from IPMI's own threshold vocabulary: the firmware has already compared each reading against the thresholds it was configured with, and this module does not second-guess that with limits of its own. A sensor row it cannot read is reported and counted, and never darkens an otherwise healthy card.

The **Overview** card turns that into one picture: a sentence saying how the fleet stands, a ring of machines split into nothing-wrong, needs-a-look and critical, a wall of per-machine cards worst-first with their faults pinned, and the counts underneath.

Above the wall, and **only while something is wrong**, sits an attention meter. It is not a measurement - it is a severity level, drawn in the same bars the per-core CPU readout uses. A warning holds a steady amber whose length tracks how much of the fleet is affected. Anything critical pulses, and so does the card of each broken machine, so the wall points at the one to open rather than just going red.

The module does not choose that: it says *this is urgent* and the app decides what urgent looks like, which is also why the pulse respects a reader's reduced-motion setting and falls back to a ring that says the same thing standing still.

## Controls

The drawer for a machine provides, in the order you usually need them:

- sensor readings, with the numeric value and unit pulled out for sorting, and - where the controller was configured with thresholds - the nearest one and how much room is left before it;
- the newest system event log entries, with an explicit destructive confirmation before clearing them - and a warning above them when the controller's own clock is far enough out that those times cannot be lined up against anything else;
- power on, ACPI soft shutdown, immediate power off, power cycle, hard reset;
- one-time or persistent boot-device selection;
- UID/chassis-identify LED timing;
- a **serial console** (IPMI Serial-over-LAN): the machine's own serial line, over the network, showing boot messages and a login prompt whether or not its operating system has a working network. It opens as a real shell in the app's terminal list and outlives the drawer, so closing the card does not end the session. A BMC allows one at a time;
- controller, FRU and LAN details.

Hard power operations and event-log clearing always require confirmation in the UI.

## Polling and rules

The slow `bmc` interval controls network sweeps. A sweep reads `chassis power status` from every machine that is switched on for sweeping, and re-reads its sensors on a slower cadence of its own. Management details, sensors and event-log rows are also fetched while their drawer is open, and cached briefly so the renderer's fast refresh does not become repeated network traffic. A failed read is never cached, so the next poll retries instead of repeating an error.

**Module settings → Behaviour** exposes four rules. Leave a field empty to keep what it is now.

| Rule | Default | Range | What it does |
|---|---|---|---|
| Machines swept at once | 4 | 1-16 | How many BMCs are asked in parallel. |
| Read sensors every Nth sweep | 3 | 0-20 | Power moves and is read every sweep; sensors move slowly. `0` switches sensor health off and returns colour to power state alone. |
| Event log entries fetched | 100 | 10-1000 | How many of the newest SEL entries a drawer asks for. |
| Identify blink default | 15 | 0-255 | What the Blink UID LED prompt opens with. |

A machine can be **parked** rather than deleted: it keeps its row and its credentials, nothing is asked of it, and it counts towards neither health nor the fleet figures. At most 64 machines are kept.

The **Sweep now** and **Look again** buttons perform an immediate capability check and sweep. A successful power action also refreshes that one machine immediately.

The BMC list belongs to the module, not to whichever machine is acting as the management station - connect a second machine with this module enabled and it reaches the *same* endpoints. So the automatic sweep does not run twice against them, only one connected machine's instance runs it: whichever has this module's tab open, or the one that connected first if none does. **Sweep now** always runs, from whichever machine is open.

## Limitations

- IPMI 2.0 `lanplus` is the only transport.
- A serial console session is opened by staging the password into a private temporary file on the connected machine and pointing `ipmitool -f` at it. The password never appears in a command line at either end, and the file is removed when the session ends - but it does exist, mode 600, for the length of the session.
- Vendor-specific OEM commands are not used.
- Sensor and event-log wording comes from each BMC firmware. The module preserves unrecognised entries instead of guessing vendor-specific semantics, and event-log timestamps stay as the BMC's own clock wrote them rather than being converted into a timezone nobody chose.
- Nothing reaches you when the app is closed. The module raises a notice when the fleet crosses into critical and again when it comes back, and that reaches you anywhere **in** the app - but desktop notifications need a secure context and Bored Manager is normally served over plain HTTP on a LAN address, so there is no way to tell somebody who is not looking at it.
- Bulk power actions address machines by id and carry no revision, so a selection made before somebody else edited the list acts on whatever those ids name now. Rows that have gone are skipped and counted rather than guessed at.

## Files

| File | Purpose |
|---|---|
| `main/index.ts` | Module activation: six lifecycle hooks and nothing else. |
| `main/runtime/` | The wiring layer - the object graph, readiness, and every RPC handler. |
| `main/store/` | The settings document: its shape, its defensive reader, and its cache. |
| `main/ipmi/` | Command construction, output parsing, failure classification and its messages. |
| `main/sweep/` | The sweep, the health model, the history points, and the Overview payload. |
| `main/machines/` | The check-before-apply machine editor and its table rows. |
| `main/queries.ts` | Cached detail, sensor and event-log reads. |
| `main/actions.ts` | Power, boot-device, identify and event-log actions. |
| `main/rules.ts` | The four tunable sweep rules. |
| `main/probe.ts` | Detects `ipmitool` on the connected machine. |
| `main/store/credentials.ts` | The encrypted credential store, and the one-way move out of clear text. |
| `main/badges.ts` | One colour per meaning, for every chip the module renders. |
