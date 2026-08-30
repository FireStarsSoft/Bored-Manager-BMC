# Changelog

Module versions are independent of the app's. Version 1.0.0 required Bored Manager **0.3.2**; 1.0.8 raised the floor to **0.4.0**, and 2.0.0 raises it to **0.6.0** - the release that gave modules an encrypted credential store and an attention signal, both of which this one depends on.

## 2.0.0

The release this module existed to make. Until now a machine's colour came from
its chassis power state alone, so a server whose fan had failed and whose inlet
was at 90 °C reported **Power on**, in green - technically true, and the single
most useful thing this module could have said, missed.

- **Sensor readings decide a machine's health.** A sweep now re-reads each
  machine's sensors on a cadence of its own and folds the result into the card:
  worst wins, so a critical sensor turns a running machine red and a
  non-critical one turns it amber. Severity comes from IPMI's own threshold
  vocabulary - the firmware has already compared each reading against the
  thresholds it was configured with. A sensor row the module cannot read is
  reported and counted, and deliberately never darkens an otherwise healthy
  card: teaching people to distrust the colour would cost more than the row is
  worth.
- **The Overview card became a fleet health wall.** A ring showing the share of
  swept machines with nothing wrong, a per-machine wall sorted worst-first with
  its faults pinned, and - only while something is wrong - an attention meter.
  A warning holds a steady amber whose length tracks how much of the fleet is
  affected; anything critical pulses, and so does the card of each broken
  machine, so the wall points at the one to open rather than just going red.
  The module says *this is urgent* and the app decides what urgent looks like,
  which is also why the movement respects a reader's reduced-motion setting.
- **IPMI passwords are encrypted now, and this module stops apologising for
  them.** Until Bored Manager 0.6.0 a module could persist JSON and nothing
  else, so these sat in clear text in `module-config/bmc.json` and every screen
  that showed the machine list had to say so. They now live in the app's own
  secret store, encrypted with the install's key, read back one at a time at
  the moment they are needed and held nowhere. **Upgrading moves them for you**
  on the first sweep, and if anything goes wrong part-way the old file is left
  exactly as it was, so the module keeps working and tries again.
  If `data/secret.key` is ever lost the passwords are gone with it - but the
  module can tell that apart from "never set", so the affected rows say *enter
  it again* instead of quietly failing to authenticate, which is how BMC
  accounts get locked.
- **Power draw, where the controller will say.** Boards that implement DCMI
  are asked what the chassis is drawing, on the same cadence as sensors. It
  shows on the card as a plain figure rather than a colour - nothing here knows
  what a given machine ought to draw - and the Trends tab charts the fleet total
  over twelve hours. A board that does not implement DCMI says so once and is
  never asked again, so the cost is one command per machine per sensor sweep
  and only for the boards that answer it.
- **A critical fleet now interrupts you.** When the fleet crosses into
  critical - and again when it comes back - the module raises a notice that
  reaches you anywhere in the app, not only on its own pages. It fires on the
  change rather than on the state, so a fault that lasts all afternoon is one
  interruption and not one per sweep. Nothing reaches you with the app closed:
  desktop notifications need a secure context and this app is normally served
  over plain HTTP.
- **A serial console.** IPMI Serial-over-LAN, from the machine's own card: its
  serial line over the network, showing boot messages and a login prompt
  whether or not the operating system has a network of its own. It was left out
  of every earlier version for a good reason - a `terminal` block's command is
  built in the browser, so a password in one would be visible in the spec and
  on the wire. Bored Manager 0.6.0 lets a module compose that command on the
  server instead, so the password is staged into a private file over stdin and
  the command carries only a path.
- **A log of when each machine changed**, on the Trends tab, kept for six
  months. The charts beside it are metrics history, which the app sweeps within
  forty-eight hours at the most - right for a line on a graph, useless for the
  question people actually arrive with, which is how long something has been
  happening. Only real changes are written: a fleet behaving itself costs
  nothing at all, and a machine that has not been checked yet or has been
  parked is an absence rather than a state, so neither puts a row there.
- **A warning when a controller's clock is wrong.** Every timestamp in an event
  log comes from the BMC's own clock, so one running hours out turns its whole
  log into something nobody can line up against anything else - and unlike a
  failed fan, none of that is visible until somebody tries to correlate an
  incident and finds the times disagree. It is checked about once an hour,
  shows as a chip on the card and as a plain sentence above the event log, and
  is deliberately never folded into the machine's colour: the hardware is fine,
  the log is what suffers.
- **Sensor thresholds.** The drawer's sensor table now shows the nearest
  threshold the controller was configured with and how much room is left before
  it, so "ok" becomes "ok, and eight degrees from not being". It costs a second
  command, and only in the drawer - a sweep never asks for it.
- **An Attention tab**: every sensor across the whole fleet that is not ok, in
  one table, worst first. It is built from what the sweep already collected, so
  opening it asks nothing of any BMC. Finding out what was wrong with a rack
  used to mean opening cards one at a time until the red one turned up.
- **A Bulk power tab**: tick several machines and act on all of them at once,
  bounded by the same concurrency rule as a sweep. Rows that have gone since
  you ticked them are skipped and counted rather than guessed at, and the
  result names what it could not reach.
- **Machines can be parked.** Switching sweeping off for an entry keeps its row
  and its credentials and stops asking it anything, so a machine that is off for
  a fortnight does not have to be typed in again - and reads as parked rather
  than as unreachable. At most 64 machines are kept, because each one costs an
  ipmitool call per sweep.
- **Four rules you can change**, under Module settings → Behaviour: how many
  machines are swept at once, how often sensors are re-read, how many event-log
  entries a drawer fetches, and what the identify prompt opens with. All four
  were constants. Leaving a field empty keeps what it is now.
- **Failures say what to do about them.** `unreachable | auth | error` became
  `unreachable | timeout | dns | auth | refused | error`, each with a written
  explanation naming the likely causes in the order they are usually true. A
  BMC that answered without a power state is no longer reported as unreachable.
- **Errors are no longer swallowed.** `sensorRows` and `selRows` answered with a
  bare `[]` when a read failed, so "this BMC has no event log entries" and "this
  BMC did not answer" drew the same picture. **This is a breaking change to both
  methods**, which now answer `{ rows, problem }`; the pages that read them ship
  in the same archive, so nothing outside this module sees it.
- **Readiness has five states** - connecting, checking, blocked, attention,
  ready - and both pages gate on it, so a page that is merely starting no longer
  looks like a broken one. A probe that threw stays *checking* and retries,
  rather than accusing the connected machine of missing a tool.
- **Both pages regrouped.** Management is Fleet, Attention, Trends and Bulk
  power; the machine drawer
  now opens with sensors and the event log, because that is what you opened it
  for, with the power controls below them rather than under the mouse. Settings
  is Machines, Behaviour and Readiness. Explanatory prose moved out of field
  hints into notes you can switch off, and warnings stay visible whatever that
  switch says.
- **Trends** charts fleet sensor faults over six hours alongside power states
  over one. The two new keys are additive: existing history is unaffected.
- Sensor readings now carry their number and unit separately, so a table can
  sort by temperature; an implausible reading (a lost sensor's 65535 RPM) keeps
  its raw text and drops the number rather than poisoning a comparison.
  Duplicate sensor names are disambiguated on the name, not by suffixing the
  hex id, which could collide with a real one.
- The settings table reports its last test as a raw timestamp for your browser
  to render, instead of a clock time baked in the server's own timezone.
- The module was reorganised into `runtime/`, `store/`, `ipmi/`, `sweep/` and
  `machines/`, with `index.ts` reduced to its six lifecycle hooks.
- The unused `hostData` storage grant was dropped from the manifest.
- **Upgrading** keeps everything: a version 1 settings document is read with
  every machine enabled and every rule at its default, and is only rewritten
  when you next change something.

## 1.0.9

- **Declares the storage it uses.** Bored Manager 0.5.0 lets a module say in its
  manifest what it needs kept for it, and grants that rather than applying one
  fixed cap to everything. This module asks for what it already used: the same
  512 KB for its settings and for what it remembers per machine.
  It writes one history stream of its own (`bmc`) and is granted 32 MB of the
  metrics store for it.
- **Nothing else changed**, and nothing about it needs a newer app. `minAppVersion`
  is untouched: an app that has never heard of a `storage` block ignores it, so
  this release installs on 0.4.3 exactly as the previous one did. On 0.5.0 and
  later it also shows up in Settings → Data & storage with its own figures.

## 1.0.8

- **The module now lives in its own repository** and is installed rather than
  shipped: [FireStarsSoft/Bored-Manager-BMC](https://github.com/FireStarsSoft/Bored-Manager-BMC).
  Bored Manager 0.4.2 is the first release that does not bundle it - get it from
  Settings → Modules (the official list, `FireStarsSoft/Bored-Manager-BMC`, or the
  release zip). An install that already has 1.0.7 keeps working untouched
  across the app update, and updating to 1.0.8 keeps its configured BMCs, credentials and history:
  nothing about the module's behaviour, manifest ids or stored shapes changed
  here.
- README: an Installing section, since the module is no longer in the app
  download, and a link back to the repository.
- `minAppVersion` corrected to **0.4.0**. The manifest said `0.3.2`, but the
  config store calls `ctx.onConfigChange` and the poller reads
  `ctx.isPrimaryInstance` - both of which the app only provides from 0.4.0.
  On anything older the install passed the version gate and then threw
  `ctx.onConfigChange is not a function` during activation.

## 1.0.7

- README: the Management page's new "Fleet power over time" chart is in the
  page list, and `lanplus` is described as the only transport rather than as
  the only transport "in version 1.0.0".
- README: the Overview row now names the card ("BMC machines") and says it is
  off by default, so it can be found in Settings by the name it has there.

## 1.0.6

- The Management page charts the sweep's power counts over time ("Fleet power
  over time"). The module has emitted a `series` point and written the `bmc`
  history stream every sweep since 1.0.0, but no page ever read either - the
  data was collected, pushed to every browser and stored for nothing.

## 1.0.5

- Performance: the module config (the machine list) was re-read from disk and
  re-validated on every call - several times per sweep, and once per 2-second
  table poll. It is now parsed once and kept until any connected machine's
  instance of this module writes it, which is what `onConfigChange` reports.

## 1.0.4

- **Fixed: with two machines connected and this module enabled on both, each
  ran its own automatic sweep of the same configured BMC endpoints** - only
  one connected machine's instance runs the automatic sweep now; a manual
  "sweep now" still works from either.

## 1.0.3

- **Fixed: the "seen `<time>`" chip on a Machines card was rendered in the
  server's own locale/timezone, not the viewer's** - a server left on UTC
  could show a time of day quite different from the browser looking at it.
  It reads in the viewer's own locale now.

## 1.0.2

- **Fixed: the Machines section's refresh button always showed "never" for its
  age**, even right after a sweep had just completed - the section had a
  refresh control but nothing feeding it a timestamp. It now resolves the age
  from the machines stream's own `t`.

## 1.0.1

- Exposes the BMC table refresh and controller sweep intervals in Settings. The sweep remains background monitoring; choosing Manual only leaves it to explicit refreshes.

## 1.0.0

First release.

- Store named BMC endpoints and IPMI credentials in module settings behind a check-before-apply workflow.
- Show every configured controller in a status wall with current reachability and chassis power state.
- Inspect standard controller, FRU, and LAN information.
- Read sensors and the latest system event log entries.
- Control chassis power, boot-device override, and the UID identify LED.
- Protect destructive operations with explicit confirmation.
- Poll with bounded concurrency and cache drawer queries to avoid flooding management controllers.
- Publish an optional Overview status donut and compact history counts.
