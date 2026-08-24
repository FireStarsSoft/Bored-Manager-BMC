# Changelog

Module versions are independent of the app's. Version 1.0.0 requires Bored Manager **0.3.2**.

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
