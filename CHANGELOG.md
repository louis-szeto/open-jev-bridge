# Changelog

## 0.4.1

- Add explicit `SYSTEM_ONE_SHISA_BACKEND=llamacpp` / `--shisa-backend` for local GGUF Shisa. Preserve vLLM as default.
- Use native tokenizer, template, props and completion contracts with per-slot context checks and complete restricted-letter readout.
- Recover missing option rows with validated equal-bias normalization, not an unsupported vLLM prompt-logprob request.
- Persist backend selection for direct hooks and propagate it to the bundled native Claude function plugin; allow bodyless GET in the isolated function transport.
- Add empty-token reproduction, independent numerical oracle, all-tools API/MCP and installed-hook/function-bundle regressions.
- Improve wrong-backend diagnostic, retain clean archive and ready-to-use function plugin.


## 0.4.0 — additional local decision backends

- Add the `decider` profile, native typed API/model-list handling and independent score/probability rounding validation.
- Add a bounded eager CUDA HTTP wrapper for Mapika Decider 35B, disabling unsupported dense-model graph loading and rejecting truncated inputs.
- Add the `shisa` vLLM transport: served-template/tokenizer checks, native option-letter logprobs, exact missing-letter fallback, typed normalization, logical deadlines and cancellation.
- Share adapters with MCP tools, automatic hooks and the bundled Claude function-hook plugin. Preserve all existing provider integrations.
- Add provider fixtures, all-tool/CLI/MCP/installed-hook/bundled-function e2e tests, Python wrapper tests and adapter-overhead benchmarks. No new Node dependencies.
- Persist nonsecret Shisa configuration during direct installation; align CLI/MCP/plugin release versions. Preserve the bundled function plugin when tests regenerate it.
- Keep the source archive free of reports, locks, checksums and caches; CI no longer requires a removed npm lockfile.


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
