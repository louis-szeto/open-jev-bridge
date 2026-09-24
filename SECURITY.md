# Security boundaries

Default network destination is loopback-only. `localhost` is normalized to `127.0.0.1`; non-loopback endpoints need explicit `allowRemote`/`--allow-remote`. The Node transport refuses redirects, limits request and response bytes, bounds concurrency and queues, supports cancellation, has finite deadlines and a circuit breaker. Optional API keys are read from the environment/config or a bounded owner-only regular key file and never placed in URLs or echoed from server error bodies. Kev's own server has no authentication by default: keep it on loopback or place it behind an authenticated, encrypted private proxy.

MCP tools only judge supplied data; they neither execute commands nor fetch document URLs. Regex patterns run in disposable resource-limited workers with a per-field deadline. Shell execution is limited to explicitly requested installer/host-check commands and trusted hook launchers, never classifier output. State is private (directories 0700, files 0600) with atomic replacement and exclusive lock files. Session IDs are hashed into filenames. Transcripts are read as bounded regular files without following a leaf symlink. Parent directories, the repository, the home directory and the configured server are trusted administrative inputs; this is not a sandbox against another process running as the same OS user.

Prompt-injection screening is advisory, not a security boundary, and cannot remove text already present in the main model's context. Belay recognizes observed execution evidence heuristically; forged tool output, unusual runners or malicious same-user actors can defeat it. A fresh passing check does not establish adequate coverage. Compaction can remove useful context on an incorrect model judgment, so pinned content, atomic validation and built-in fallback reduce but do not eliminate risk.

The optional Claude function adapter runs in the host's isolated JavaScript runtime, not Node. Its HTTP transport cancellation/redirect behavior is controlled by the host's `$.http.fetch`; do not infer Node-transport guarantees for this experimental path. Use a trusted endpoint and do not expose credentials or point it at a redirecting endpoint. Failures return to built-in compaction.

Fail-open Stop hooks preserve work on API errors, incomplete transcripts or state-lock contention. This is a productivity safety net, not a mandatory security enforcement gate. The MCP judgment tools instead return explicit errors/review/escalation; they never label a malformed answer an approval.

Installation requires user authorization, preserves other hooks, refuses unowned MCP-name/skill conflicts and uses host CLIs for MCP changes. Codex still requires native `/hooks` trust. Do not enable native plugin variants and direct hooks simultaneously. Install/uninstall operate under a private installer lock; external simultaneous edits to the same host settings are not coordinated. Close host settings editors during installation.

No telemetry, analytics, hosted fallbacks or automatic model downloads are included. Private checkpoints contain verbatim historical material: protect them and remove obsolete files deliberately. Expired checkpoints are not restored, but disk files are not automatically deleted. A process killed while holding a lock may leave it behind; hooks bypass safely. Confirm no active hook/installer is using a stale lock before removing that lock file. Uninstall preserves configuration/checkpoints and modified skill files.

This artifact has not received an external security audit. Report defects privately to the maintainer of the repository you create from this ZIP; no fictitious contact address is provided.

## Multi-provider and Laya sidecar boundaries

Hosted Jev receives the selected request content; there is no implicit permission to export confidential evidence. Remote access requires explicit opt-in. A provider profile never changes the endpoint or adds credentials. When changing endpoints, remove obsolete environment secrets and persisted key-file paths so an old bearer key is not sent to the new destination. Keys never belong in PATH, source code, model URLs or command arguments.

The optional Laya Python HTTP sidecar uses the standard-library HTTP server for a local-only deployment, not a public internet service. It caps active HTTP handlers at 16, holds at most one inference lock, rejects excess inference with 429, times out socket reads, bounds request/response bytes, and rejects input that would be truncated by the inspected Laya sequence builder. It neither rewrites questions nor evaluates partial evidence silently. A Node client timeout cannot interrupt an in-progress GPU forward pass; the inference slot remains occupied until that pass ends. A reverse proxy is required for a deliberately protected remote service.

Laya imports and optional model dependencies are not installed by npm or test fixtures. Review and pin Python/model dependencies for your production deployment. The adapter's tokenizer preflight is based on the inspected upstream allocation; rerun compatibility checks when upgrading Laya. Model weights, statistical calibration and native-host execution are outside offline fixture certification.


## Automatic mode added in 0.3.0

Automatic patch/completion gates send selected observed edits and check evidence to the configured endpoint. Automatic external screens send the selected complete source result. With an explicitly enabled hosted provider this is off-machine processing; use a local provider or disable the corresponding automatic task for confidential data. Redaction is best effort.

The bridge never executes project tests from a hook or auto-grants tool permissions. It asks the main agent to use its normal authorized tools. Event ledgers are private local files, may contain tool inputs/results, and should be treated as sensitive. Gaps and overflows disable confident verification. Advisory screening is neither universal coverage nor a prompt-injection-proof enforcement layer.

See docs/AUTOMATION.md for shared-session child observation handling, bounded continuation and failure behavior.

## Native local-model adapters

Decider and Shisa use explicitly configured local endpoints; no URL is inferred from model output. Shisa never treats generated text as a typed judgment. Its tokenizer, option IDs, prompt prefix, top logprobs and forced-append logprobs are validated; absent evidence is not filled with fabricated zeros. Only the declared 26-letter readout is supported. The Decider wrapper rejects truncation before GPU admission and requires eager BF16 CUDA loading. Both sidecars reuse bounded loopback HTTP plumbing and optional bearer authentication. A client timeout does not cancel already-running CUDA kernels. Native Claude owns isolated-hook I/O cancellation; the bridge enforces elapsed-budget checks between requests and before returning compaction. Calibrate thresholds separately for each backend.
