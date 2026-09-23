# Changelog

## 0.3.0 — host-driven automation

- Inject proactive tool policy at startup, prompts, child starts and post-compaction recovery.
- Install event-based edit/check tracking, automatic Stop task review, child completion review, Claude task-completion enforcement, and advisory matched external-result screening.
- Fix failing-test masking by an unrelated passing check; require a later successful rerun of the same failing command and actual start-after-edit ordering.
- Recheck new corrective evidence after a Stop continuation; deduplicate exact completed reviews and bound continuation without pretending capped or unavailable reviews passed.
- Preserve observation gaps explicitly and separate child ledgers; mirror shared-session child observations into an existing parent timeline.
- Refresh owned hook definitions on same-path upgrades; preserve user-authored skills and unrelated hooks. Persist nonsecret routing settings, never inherited bearer values.
- Add offline automation readiness reporting, provider-profile hook tests and installed-event subprocess end-to-end tests.
- Harden optional Claude automatic-compaction concurrency and add validated opt-out/threshold controls.


## 0.2.0 — provider-neutral Open Jev Bridge

- Renamed the package, CLI, plugin registrations, skill folders and canonical MCP tools to provider-neutral names. Bridge configuration now uses `SYSTEM_ONE_*`; legacy bridge environment variables are not silently read.
- Added `generic`, `jev`, `kev` and `laya` contract profiles without automatically changing endpoints or starting models.
- Normalized Jev `models[].name` and Kev/adapter `models[].id`; added Jev score constraints, bearer-key file configuration, optional overload retries and provider-aware response validation.
- Added a loopback Laya HTTP sidecar using the real Python SDK in production. Its preflight rejects state, instruction or option truncation rather than silently losing evidence.
- Preserved all fourteen workflows and existing hook/compaction safeguards; added provider contracts, Python adapter tests and Python-to-Node/MCP subprocess tests.
- Added three complete deployment examples, a compatibility/source audit, migration guidance and explicit live/native-host acceptance boundaries.

This is a namespace-breaking release. Uninstall old direct integrations from the previous checkout before installing the new registration to avoid duplicate hooks. Original user state and configuration are not automatically deleted or migrated.
