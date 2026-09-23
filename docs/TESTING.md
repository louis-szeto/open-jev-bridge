# Multi-provider release validation

The complete suite requires Node 22.16+ and Python 3.10+. `npm test` runs Node tests and the Python adapter tests. `npm run test:providers` exercises Jev/Kev/Laya-shaped HTTP contracts and the actual Python-adapter-to-Node/MCP chain with an explicit fake agent. `npm run test:adapter` runs Python-only adapter tests. `npm run validate` records syntax/plugin checks, Node tests, adapter tests, Node coverage and benchmarks. See [PROVIDER_COMPATIBILITY.md](PROVIDER_COMPATIBILITY.md) for contract provenance and [../reports/validation.json](../reports/validation.json) for actual counts.

The Node runtime does not require Python. Only the optional Laya serving adapter and full offline development suite use it. No neural backend, paid API or credentials are silently substituted by fixtures in live mode. Current Laya short context can cause intended 422 failures in long-context live workflow tests. Those are not marked as passes.

# Testing, measurements and release gates

## What was actually executed

`reports/validation.json` is the machine-readable summary for this ZIP. `reports/tests.log`, `reports/coverage.log`, `reports/check.log` and `reports/benchmark.log` preserve raw results. Offline means the HTTP peer is an explicit deterministic loopback fixture, not a real neural model. A real Node subprocess runs the MCP server; a separate test client drives its wire protocol. Installer tests use explicit fake Claude/Codex CLIs, not authenticated host applications.

No live Jev API credential, Kev/Laya model, Claude binary or Codex binary was available in the build environment. Their absence is documented as **NOT_EXECUTED**, not skipped tests folded into a green live claim. No subagent runner was available. Model-quality certification, host-wide compatibility and external security review are not asserted.

## Suite map

| File | Coverage |
|---|---|
| `schema.test.mjs` | JSON states, all three question/answer families, malformed types, nonfinite numbers, missing/extra probability keys, argmax, score means/legends, missing confidence, 255-option rounding, prototype-like IDs, endpoint normalization, IPv6/private endpoints, config constraints and secret redaction |
| `compact.test.mjs` | Keep/truncate/drop thresholds, pairing, pinning, pending/opaque messages, verbatim prose/order, immutable inputs, host handles, no result bodies in state, impossible budgets, bounded batching, malformed-answer atomicity and seeded invariants |
| `belay.test.mjs` | Real versus quoted runner commands, output summaries and failures, fresh-check ordering, current-turn boundaries, no-network fast paths, false completion, explicit blocked/partial claims, redaction and both transcript families |
| `tools.test.mjs` | All 14 tool entry points, strict argument validation, ten aliases, all ten judgment policies, partial invalid results, null confidence, conflicts, ordering, missing evidence, safe exact extraction, regex syntax/cancellation/timeouts, context limits and reserved IDs |
| `client.test.mjs` | Actual loopback HTTP endpoint/body/headers, optional auth, model option, `/models`, 3xx/4xx/5xx, invalid UTF-8/JSON/content type, response/request byte caps, slow streaming deadlines, caller cancellation, bounded queues, retries and circuit recovery |
| `hooks.test.mjs` | Stop outputs, active-hook guard, cooldown/caps/dedup, concurrent lock behavior, shadow/fail-open, immutable transcript files, checkpoint scope/expiry/one-time restore, private permissions, leaf symlink rejection and isolated function adapter behavior |
| `mcp.test.mjs` | Real subprocess handshake, tool catalog and all tools over stdio/HTTP, error framing, unknown methods, pre-init rejection, Unicode chunking, oversized frames, cancellation and CLI fail-open/errors |
| `install.test.mjs` | Both host CLI argument sets, original settings preservation, idempotency, rollback, unowned-name/skill conflicts, token non-persistence, quoting, exact owned-hook removal and failed-discovery distinction |
| `providers.test.mjs` | Three provider contracts, fourteen tools each, model-list normalization, Jev limits, current/legacy rounding, metadata/confidence validation, bearer secrets and private key files, retries, CLI/MCP and isolated function hooks |
| `laya-e2e.test.mjs` | Actual Python sidecar subprocess to Node client, CLI and MCP; explicit fake agent, three answer types, authentication, model identity and truncation rejection |
| `python/test_laya_adapter.py` | Python request validation, tokenizer-budget boundaries, HTTP/authentication, errors, limits, concurrency and redaction; no model weights |
| `e2e.test.mjs` | CLI install -> execute generated hook command -> real bridge HTTP -> completion block/verified allow -> execute registered MCP launcher -> uninstall, plus the doctor probe |

The fixture contract checker intentionally does not import the production schema validator. Fixture answer construction is distinct from result interpretation. Nevertheless these tests establish bridge logic and protocol behavior, not the semantic accuracy of any provider. Native function hooks are tested with a host API double; the real host runtime remains an explicit acceptance gate.

## Commands

```bash
npm run check             # syntax, strict schemas, manifest paths and generated variant integrity
npm test                 # complete deterministic offline suite
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:coverage     # Node's source coverage output
npm run benchmark        # bridge/fixture measurements, not inference
npm run validate         # check + all tests + coverage + benchmark, with saved logs and summary
```

No npm runtime/test dependencies are needed. The lockfile allows `npm ci --ignore-scripts`; it does not fetch a dependency tree. A Linux/macOS Node 22/24 CI matrix is provided; only the specific local build environment recorded in the report was exercised during artifact creation. Coverage reports are observational, not a claim of 100% path coverage or an external audit. Benchmark thresholds are not brittle millisecond pass/fail gates; timeout/queue/worker tests enforce broad safety bounds.

## Live provider gate — fails, does not silently skip, when unavailable

```bash
# First select Jev, Kev or Laya using the complete README configuration example.
# The live commands use that selection, including its credentials and provider profile.
npm run test:live
npm run benchmark:live
```

`test:live` checks the actual model catalog, runs all 14 tool entry points, checks basic semantic fixtures and a mixed Noul/Choice/Score probe, and writes `reports/live-test.json`. A failed semantic fixture is a real failure to investigate; do not weaken thresholds to advertise green. This small smoke set is not a benchmark for production false positives, factuality, retention recall or calibration. Build a labeled task/transcript dataset for your workload before enabling strong automatic decisions.

`benchmark:live` includes the real configured endpoint's latency and records its model metadata. Record model run/base, hardware, quantization/dtype, temperature, prefix cache, state/question sizes and warm/cold behavior when comparing deployments. The shipped offline numbers are not estimates for a V100, MI50 or any model-serving hardware, and no Jev-versus-Kev speed claim is made.

## Native CLI and authenticated-session gates

After installing direct integrations, `npm run test:hosts` requires both actual CLIs, invokes native Claude plugin validation and checks both direct MCP registrations. It fails on missing prerequisites. This is a **readiness/manifest check**, not a substitute for real session testing. A native plugin installation may namespace its server differently and therefore not satisfy the direct-registration check.

Complete this acceptance checklist on the exact host versions you intend to use:

1. Configure the real selected provider, run the live gate, then install one integration mode per host. Review/trust Codex hooks through `/hooks`; do not edit trust records. Restart both hosts and verify their actual tool/hook listings.
2. In a disposable repository with a small test, ask the host to call `system_one_status`, `system_one_verify` and `system_one_gate`. Inspect the actual MCP tool invocation and result, not only assistant prose. Confirm the configured server receives the requests and no unselected endpoint is used (TypeSafe is expected only for the hosted Jev example).
3. Make a genuine edit and attempt a completion report without verification. Observe a Stop continuation when the model's valid judgment warrants it. Run the actual test after the edit; confirm completion is allowed. Confirm an honest blocked statement and an unavailable provider do not create an infinite loop.
4. For stable hooks, compact a sufficiently populated session. Inspect the private checkpoint and subsequent compact SessionStart context. Confirm the live transcript is unchanged and the host still performs its own compaction.
5. For the optional function variant, use a runtime explicitly supporting the upstream function API and launch with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. Verify module registration, `session.compact` replacement, retained call/result validity, context-triggered compaction and fallback on malformed/unavailable inference. Do not infer this worked because an isolated adapter test passed.
6. Repeat after any host, bridge or provider upgrade. Capture versions and observed results in a new release report. Run a representative labeled dataset before relying on model-selected context removal or completion blocking in important work.

Do not automate these checks by disabling permission approval, fabricating evidence, or resetting block/trust state. The repository intentionally avoids a scripted claim of authenticated native end-to-end success in an environment that cannot supply it.


## v0.3.0 automatic lifecycle acceptance

Run `npm run test:automation` for event-only and real-subprocess/HTTP automatic integration. Tests explicitly use host doubles; they do not certify an authenticated Claude/Codex session. The full `npm run validate` includes these tests and all earlier API/provider, adapter, MCP, functional and security regressions.

On **each actual native client**, after configuring the provider and trusting the hooks:

1. Run `doctor` and `automation-status`. Confirm the expected direct-install events and that neither the backend nor host hook settings are disabled. For native plugin mode inspect the native plugin and hook menus instead of treating a missing direct receipt as a failure.
2. Start a new session in a disposable repository. Ask for a small code change without mentioning System One or any MCP tool. Observe the actual PreToolUse/PostToolUse and Stop invocations. Verify that a false completion before tests produces a continuation, not a fabricated test pass.
3. Let the host run a real relevant test. Confirm a later successful check triggers automatic task review. Run a failing test followed by successful lint; confirm the test failure remains unresolved until its own successful rerun.
4. Delegate a small code task. Confirm a child Stop is checked against child evidence. In Claude, exercise TaskUpdate to completed and observe exit-2 blocking on missing verification.
5. Fetch a short external document through a hook-supported tool. Confirm automatic screening appears without an explicit MCP request. Hosted Codex web tools have different coverage; do not report them as screened by this hook.
6. Exercise native automatic compaction and confirm a checkpoint plus policy is restored before the next model request. For optional Claude functions, confirm the loaded `turn.complete` handler actually invokes compaction and retained messages replace active history on the supported runtime. These are separate acceptance cases, not interchangeable.
7. Disconnect the provider. Confirm checks are recorded as unavailable, no verification is certified, and the host is not trapped in a loop. Reconnect, change evidence, and confirm review runs again.

Record host versions, provider/model versions, chosen settings and observed hook trace in a local acceptance report. No live native or real-model pass is claimed in the supplied offline validation report.
