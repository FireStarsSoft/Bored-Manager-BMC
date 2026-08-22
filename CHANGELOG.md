# Changelog

Module versions are independent of the app's. Version 1.0.0 requires Bored Manager **0.3.2**.

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
