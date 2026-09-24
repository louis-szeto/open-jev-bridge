# Open Jev Bridge — local MCP, Claude Code and Codex hooks

A provider-neutral Node.js MCP server and plugin repository combining **verbatim compaction**, **evidence-sensitive completion checks**, and **ten purpose-built judgment tools**. Connect it to hosted **Jev**, local **Kev**, local **Laya** and **Mapika Decider 35B** through included HTTP adapters, local **Shisa DE-1** through vLLM or llama.cpp (GGUF), or another compatible System One service. The Node runtime has **zero npm dependencies**. All bridge environment variables use **`SYSTEM_ONE_`**, and all canonical MCP tools use **`system_one_`**.

The common tool interface uses typed `noul`, `choice` and `score` questions. Native System One providers receive `POST /v1/systemone` with `{model, state, questions}`. The **`shisa` profile selects either vLLM or llama.cpp endpoints with `SYSTEM_ONE_SHISA_BACKEND`**, validates the model-specific prompt and reads option logprobs—not generated answer text. No `response_format: "system_one"` field is invented. URL, model, optional bearer key, profile and explicit remote permission are configurable; a profile never downloads or starts a model. Default connection remains `http://127.0.0.1:8009`, model `kev-latest`, for an existing local Kev setup. There is **no automatic cloud fallback or telemetry**.

Inspired by [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction), [jev-belay](https://github.com/valentynkit/jev-belay), and [jev-mcp](https://github.com/jkudish/jev-mcp). This is an independent implementation covering their principal functions, not a vendored fork or a claim of identical interfaces for every upstream version. Source findings and identifiers are in [UPSTREAM_REVIEW.md](docs/UPSTREAM_REVIEW.md).

> **Important host distinction:** both hosts receive local MCP tools and completion Stop checks. Stable command hooks create compaction checkpoints; they cannot directly replace live history. An additional **opt-in Claude function-hook plugin** implements true history replacement on a supporting runtime. Codex's documented PreCompact output does not provide that replacement operation. No rollout/transcript file is edited to fake it.

## System One API compatibility

**Open Jev Bridge is backend-agnostic. Any service implementing the System One HTTP contract can be used by configuring the endpoint parameters; Jev, Kev, and Laya are examples, not hard-coded dependencies.** The bridge sends `POST /v1/systemone` with `model`, `state`, and typed `questions`, and expects typed `answers` for `noul`, `choice`, and `score`. Configure `SYSTEM_ONE_URL`, `SYSTEM_ONE_MODEL`, the optional `SYSTEM_ONE_API_KEY`, `SYSTEM_ONE_ALLOW_REMOTE`, and normally `SYSTEM_ONE_PROVIDER=generic` for an otherwise compatible implementation. Native-provider profiles add known contract checks. The `shisa` profile additionally supplies a model-specific transport adapter; a generic OpenAI chat server is not automatically a System One backend.

The backend may be local, on another machine, or hosted behind an authenticated HTTPS endpoint. A compatible API still needs to respect the requested question semantics and return valid probability distributions; `doctor` checks the transport/shape but does not certify model quality.

## Shisa GGUF on llama.cpp (template fix in 0.4.2)

The v0.4.0 Shisa adapter expected vLLM. For a locally running **llama-server**,
select its native protocol explicitly; changing the URL alone is insufficient.
The `tokens: []` / `shisa: missing tokenizer tokens` failure is covered by a
regression test.

**0.4.2 fixes `served GGUF chat template differs from the documented Shisa scaffold`.**
The native adapter now renders Shisa's published scaffold itself and sends its
validated token IDs to `/completion`. It does not call `/apply-template`, adopt
an alternate GGUF chat format, or require changing `--jinja`. Keep the existing
server running; update the bridge and restart its host/MCP processes. No new
configuration variable or validation-bypass flag is needed.

```bash
export SYSTEM_ONE_PROVIDER=shisa
export SYSTEM_ONE_SHISA_BACKEND=llamacpp
export SYSTEM_ONE_URL=http://127.0.0.1:8012
export SYSTEM_ONE_MODEL=shisa-de-1
export SYSTEM_ONE_SHISA_MAX_PROMPT_TOKENS=8192

node bin/open-jev-bridge.mjs doctor
# Direct installations only; use the same checkout path as before:
node bin/open-jev-bridge.mjs install --host both
```

Installation is **replace-on-install for Open Jev Bridge-owned skill names** (`system-one-judgments`, `system-one-compaction`, and `system-one-belay`). Stale, orphaned, or edited copies at those exact skill paths are overwritten by default so reinstalling is self-healing. Other skills, hooks, and unrelated host settings are left untouched. Existing skill directories are snapshotted during installation and restored if the install rolls back.

Keep your current GGUF server/GPU configuration; no additional model server is
needed. Restart client/MCP processes after updating. Native Claude function-plugin
users should refresh that plugin instead of enabling duplicate direct hooks, and
export the same settings in the launching shell. The ready-to-use function bundle
includes the new adapter. Existing vLLM setups keep `SYSTEM_ONE_SHISA_BACKEND=vllm`
(the default).

The native path uses `/props`, `/tokenize` with **`content`**, and `/completion`
with numeric prompt IDs and native probability output. Before inference it
checks that the five Shisa/Gemma control markers each have distinct single-token
encodings, occur in the expected order in the prompt, and delimit the exact answer
boundary. It also validates option-token prefix stability and the **per-slot**
context limit. It never reads sampled answer text. Missing-letter recovery is
implemented without pretending llama.cpp supports vLLM's prompt-logprob API.
`doctor` reports `prompt_source: "documented-shisa-scaffold"` and
`control_tokens_validated: true` after a successful native probe.

See **[LLAMACPP.md](docs/LLAMACPP.md)** for wire formats, the recovery derivation,
upgrade steps, serving example, targeted tests and live-validation boundaries.

## Automatic operation in Claude Code and Codex

**Lifecycle automation remains enabled by default in 0.4.2.** After installation and native hook trust, routine completion checks, patch/completion review, matched external-content screening and compaction checkpoints run without the user requesting MCP calls. The agent also receives proactive tool-use instructions at session start, each prompt and after compaction.

| Workflow | Automatic trigger | What happens |
|---|---|---|
| Verify completed work | `Stop` in both clients | Examine observed edits, check start times and actual results; request meaningful follow-up on unsupported completion. |
| Review the task after passing checks | `Stop` in both clients | Run the combined System One patch/completion gate automatically; final prose is a claim, not its own evidence. |
| Verify delegated work | `SubagentStop` in both clients | Check the child's evidence, not the parent's transcript. |
| Verify task status changes | Claude `TaskCompleted` | Block an unsupported transition using the documented exit-2 interface. |
| Screen external results | Matched `PostToolUse` | Automatically screen complete bounded WebFetch/MCP fetch/search/read_resource results; report advisory warnings. |
| Compact/recover context | Native auto/manual `PreCompact` and post-compact `SessionStart` | Create a retained checkpoint and restore a historical excerpt automatically. **Stable hooks do not replace live history.** |
| Replace live history at a usage threshold | Optional Claude function plugin | Automatically invoke `$.session.compact()` from `turn.complete`; retain selected messages or fall back to built-in compaction. |

The other judgment tools are selected by the agent when relevant; they are not all blindly called on every turn. Codex hosted web tools do not emit the same local tool hooks, so external screening is **not universal**. The main model must still treat unscreened material as untrusted. No plugin can guarantee every semantic tool-selection decision.

```bash
node bin/open-jev-bridge.mjs install --host both
node bin/open-jev-bridge.mjs doctor
node bin/open-jev-bridge.mjs automation-status --host both
# Restart the clients, then review/trust new and changed definitions in /hooks.
```

`automation-status` inspects direct-install definitions and recent metadata-only hook observations; it does not claim native trust or a successful provider probe. The separate `doctor` checks the provider. No hook runs arbitrary project commands: a continuation asks the main agent to run meaningful checks through its normal approved tools. Native auto-compaction must remain enabled for the stable checkpoint hooks to fire automatically.

See **[AUTOMATION.md](docs/AUTOMATION.md)** for the complete event matrix, safety boundaries, controls, upgrade behavior and automatic integration tests.

## What it does

| Component | Behavior |
|---|---|
| Verbatim compaction | Scores retaining old tool calls/results, keeps required pairs, shortens or removes unneeded tool output, preserves prose/order and protected messages, validates every answer before returning a new history |
| Completion Stop check | Detects observed edits followed by unsupported completion claims, discounts checks started before the latest edit, recognizes actual passing/failing runner output, requests real verification where warranted, and prevents repeat-block loops |
| Ten judgment tools | `system_one_verify`, `system_one_screen`, `system_one_find`, `system_one_classify`, `system_one_decide`, `system_one_rerank`, `system_one_compare`, `system_one_extract`, `system_one_review`, `system_one_gate` |
| Additional tools | `system_one_query`, `system_one_compact`, `system_one_belay`, `system_one_status` — **14 tools total**; optional ten `jev_*` compatibility aliases |
| Installation | One CLI command registers MCP through each host's own CLI, merges user hooks, installs skills, preserves unrelated settings and supports owned-entry uninstall/rollback |
| Safeguards | Loopback default, opt-in remote/private proxy, byte/context limits, finite deadlines, cancellation, bounded queues, circuit breaker, typed answer validation, regex worker isolation and private checkpoint state |

These are probabilistic judgments, not proofs. `system_one_review` does not run tests. `system_one_gate` does not apply patches. Screening is advisory, not an instruction sanitizer. Stop allowing completion does not certify coverage or correctness. See [SECURITY.md](SECURITY.md).

## Quick start

### 1. Select a backend

Use **one** of the following examples. When switching providers, remove obsolete `SYSTEM_ONE_API_KEY` / `SYSTEM_ONE_API_KEY_FILE` environment values and any old `apiKeyFile` entry in your chosen JSON configuration. Otherwise an explicitly configured key will also be sent to your newly selected endpoint. Restart MCP/host processes after configuration changes.

#### Jev — hosted TypeSafe API with bearer authentication

TypeSafe documents the endpoint, authentication and `jev-latest` alias in its [API reference](https://docs.typesafe.ai/api) and [model reference](https://docs.typesafe.ai/models). This example uses hosted Jev, not self-hosted Jev weights.

```bash
export SYSTEM_ONE_URL="https://api.typesafe.ai"
export SYSTEM_ONE_MODEL="jev-latest"
export SYSTEM_ONE_PROVIDER="jev"
export SYSTEM_ONE_ALLOW_REMOTE=1

# Bash: enter the key without displaying it or putting its value in shell history.
read -r -s -p "TypeSafe API key: " SYSTEM_ONE_API_KEY
printf '\n'
export SYSTEM_ONE_API_KEY

# An already exported key can instead be mapped explicitly:
# export SYSTEM_ONE_API_KEY="$TYPESAFE_API_KEY"

node bin/open-jev-bridge.mjs doctor
node bin/open-jev-bridge.mjs install --host both \
  --url https://api.typesafe.ai --model jev-latest --provider jev --allow-remote
```

**A key is an environment variable, not a PATH entry.** The bridge does not implicitly read `TYPESAFE_API_KEY`. It sends `Authorization: Bearer <key>` when configured, including for `/v1/models`, and never places the key in a URL. Jev model-list entries use `name`; the bridge normalizes them to `id` while preserving the original metadata. Selecting Jev sends the supplied evidence, task or compaction state to TypeSafe; review your confidentiality requirements before enabling a hosted endpoint.

Some hosts filter subprocess environment variables. For a persistent direct installation, an alternative is a private **key file**: the installer stores its path, not its contents, and the Node runtime reads it when required.

```bash
install -d -m 700 "$HOME/.config/open-jev-bridge"
KEY_FILE="$HOME/.config/open-jev-bridge/api.key"
# This intentionally replaces this named key file with a private empty file first.
install -m 600 /dev/null "$KEY_FILE"
printf '%s' "$SYSTEM_ONE_API_KEY" > "$KEY_FILE"

node bin/open-jev-bridge.mjs install --host both \
  --url https://api.typesafe.ai --model jev-latest --provider jev --allow-remote \
  --api-key-file "$KEY_FILE"
```

The key file must be absolute, regular, non-symlinked, at most 16 KiB, and owner-only on POSIX. A nonempty `SYSTEM_ONE_API_KEY` takes precedence over the file. Do not commit keys. The isolated Claude function-hook variant cannot read this file; use the environment method for that variant.

For environment-based Codex MCP credentials, its official [MCP configuration](https://developers.openai.com/codex/mcp) documents `env_vars`. Add this line **inside the existing** `[mcp_servers.open-jev-bridge]` table when forwarding is needed; do not create a second copy of the table or store the key value in TOML:

```toml
env_vars = ["SYSTEM_ONE_URL", "SYSTEM_ONE_MODEL", "SYSTEM_ONE_PROVIDER", "SYSTEM_ONE_API_KEY", "SYSTEM_ONE_ALLOW_REMOTE"]
```

#### Kev — existing local System One server

Follow the [Kev serving instructions](https://github.com/jaredpalmer/kev). Its Python/model environment is separate from this Node bridge:

```bash
# In a separate checkout/environment:
git clone https://github.com/jaredpalmer/kev.git
cd kev
uv sync --extra serve
uv run --extra serve python -m kev.serve --run jaredpalmer/kev-4b --port 8009
```

In a second shell, from this bridge repository:

```bash
unset SYSTEM_ONE_API_KEY SYSTEM_ONE_API_KEY_FILE
export SYSTEM_ONE_URL="http://127.0.0.1:8009"
export SYSTEM_ONE_MODEL="kev-latest"
export SYSTEM_ONE_PROVIDER="kev"
export SYSTEM_ONE_ALLOW_REMOTE=0

node bin/open-jev-bridge.mjs doctor
node bin/open-jev-bridge.mjs install --host both \
  --url http://127.0.0.1:8009 --model kev-latest --provider kev
```

Upstream Kev binds to loopback without an API key. For an authenticated private reverse proxy, set `SYSTEM_ONE_API_KEY` and deliberately allow the non-loopback URL. Current inspected Kev emits four-decimal probabilities; this bridge also retains compatibility with older two-decimal responses. No Kev weights or serving dependencies are included.

#### Laya — local Python runtime with the included HTTP sidecar

The [Laya model card](https://huggingface.co/convaiinnovations/laya) and [Python runtime](https://github.com/NandhaKishorM/laya/blob/main/laya/agent.py) expose `laya.load(...).system_one(state, questions)` / `.predict(...)`. A Hugging Face model page is **not** an inference URL. This repository includes `adapters/laya_server.py` to expose the required HTTP contract.

```bash
# From this repository, in a dedicated Python 3.10+ environment:
python3 -m venv .venv
. .venv/bin/activate
python -m pip install laya

# Loads the actual checkpoint once; no fixture or fake backend is selected.
USE_TF=0 python -m adapters.laya_server \
  --checkpoint convaiinnovations/laya --model laya --port 8010

# Alternative fixed checkpoints (choose one, not all on the same port):
# USE_TF=0 python -m adapters.laya_server --model laya --port 8010 --subfolder multilingual
# USE_TF=0 python -m adapters.laya_server --model laya --port 8010 --subfolder typed-decisions
```

In a second shell, from the bridge root:

```bash
unset SYSTEM_ONE_API_KEY SYSTEM_ONE_API_KEY_FILE
export SYSTEM_ONE_URL="http://127.0.0.1:8010"
export SYSTEM_ONE_MODEL="laya"       # Identifier defined by this adapter's --model option.
export SYSTEM_ONE_PROVIDER="laya"
export SYSTEM_ONE_ALLOW_REMOTE=0

node bin/open-jev-bridge.mjs doctor
node bin/open-jev-bridge.mjs install --host both \
  --url http://127.0.0.1:8010 --model laya --provider laya
```

To authenticate the sidecar, export the **same** `SYSTEM_ONE_API_KEY` before starting both the sidecar and the bridge. It uses one preloaded checkpoint, rejects unknown model names, binds only to loopback, caps requests and active HTTP handlers, and returns `429` rather than queuing concurrent inference. Set `maxConcurrent: 1` for this sidecar; an example is in `examples/laya.config.json`. For remote service, deploy a deliberately authenticated TLS proxy in front; the stdlib HTTP server is not a public production server.

**Laya context is not interchangeable with a long-context model.** The inspected checkpoint defaults are 512 tokens for the root English model and 1,024 for the other two checkpoints, with a separate question/options head budget. The upstream tokenizer can truncate inputs. This adapter instead performs a tokenizer-based check and rejects any request that would truncate **state, instructions or options**. Long transcripts, large class catalogs and long diffs can therefore fail explicitly. Hooks fail open or use built-in compaction; a `422` is not a successful judgment. There is no silent chunking, changed rubric, fabricated answer or automatic larger-model fallback. See [PROVIDER_COMPATIBILITY.md](docs/PROVIDER_COMPATIBILITY.md).

#### Mapika Decider 35B — local eager CUDA server

The [35B checkpoint](https://huggingface.co/Mapika/decider-35b-a3b) requires `use_graphs=False`. The included `adapters/decider_server.py` loads the actual Python model in eager mode, exposes `/v1/systemone`, and rejects state/expanded requests that exceed token budgets. Do not assume the upstream dense-model CUDA-graph server is suitable for this MoE. An existing working native `/v1/systemone` deployment is also accepted.

```bash
# From this repository in a dedicated Python 3.11+ CUDA environment:
python -m pip install 'git+https://github.com/Mapika/decider.git@b44b4c9880a67291206499b86aac89004850134a'
# --checkpoint also accepts a custom local directory downloaded with `hf download`.
CUDA_VISIBLE_DEVICES=0 python -m adapters.decider_server \
  --checkpoint Mapika/decider-35b-a3b --model decider-35b-a3b --port 8011
```

In a second terminal, from the bridge root:

```bash
unset SYSTEM_ONE_API_KEY SYSTEM_ONE_API_KEY_FILE
export SYSTEM_ONE_PROVIDER=decider
export SYSTEM_ONE_MODEL=decider-35b-a3b
export SYSTEM_ONE_URL=http://127.0.0.1:8011
export SYSTEM_ONE_ALLOW_REMOTE=0
node bin/open-jev-bridge.mjs doctor
node bin/open-jev-bridge.mjs install --host both
```

The model card specifies roughly 65 GB of BF16 weights and an 80 GB-class GPU. The wrapper does not silently use CPU, shard across GPUs, or quantize the model. Native Choice supports 2–255 options and Score 2–10 levels. The profile handles **four-decimal probabilities but two-decimal scores**, and `models[].name` discovery. The wrapper's `--model` is the served alias; `--checkpoint` is the model location. Optional local authentication uses the same exported `SYSTEM_ONE_API_KEY` in both shells. `examples/decider.config.json` demonstrates serial client concurrency.

#### Shisa DE-1 — local vLLM with restricted-letter readout

The [Shisa model card](https://huggingface.co/shisa-ai/shisa-de-1) specifies a one-token option-probability readout, not a System One HTTP route. Start a vLLM build supporting this model and the tokenization/completion extensions described in [LOCAL_MODELS.md](docs/LOCAL_MODELS.md):

```bash
# In a separate compatible vLLM/CUDA environment:
vllm serve shisa-ai/shisa-de-1 \
  --served-model-name shisa-de-1 --host 127.0.0.1 --port 8012 \
  --dtype bfloat16 --max-model-len 32768 --max-logprobs 30 \
  --logprobs-mode raw_logprobs --generation-config vllm
```

```bash
# From the bridge repository, in a second terminal:
unset SYSTEM_ONE_API_KEY SYSTEM_ONE_API_KEY_FILE
export SYSTEM_ONE_PROVIDER=shisa
export SYSTEM_ONE_SHISA_BACKEND=vllm
export SYSTEM_ONE_MODEL=shisa-de-1
export SYSTEM_ONE_URL=http://127.0.0.1:8012
export SYSTEM_ONE_ALLOW_REMOTE=0
node bin/open-jev-bridge.mjs doctor
node bin/open-jev-bridge.mjs install --host both
```

The bridge checks the served chat template, verifies single-token letters and prefix-stable tokenization, then restricts first-token logprobs to the valid options. Missing letters are recovered by the documented forced-prompt logprob path; **the sampled text is never used as an answer**. Noul maps A=Yes; Choice maps back to original IDs; Score uses the bridge-defined expected zero-based level. The current readout supports **at most 26 options/levels** and rejects larger sets rather than silently dropping or reranking candidates incorrectly. Default readout temperature is 1; optional per-type temperatures and the exact HTTP payloads are documented below.

All fourteen tools and automatic hooks use this translation, including the **already bundled Claude function-hook plugin**. Stable-host compaction remains checkpoint-based; native Claude replacement still requires its supporting runtime. Model inference quality and confidence calibration are not made equivalent by an API adapter. Shisa's approximately 48.1 GiB of weights require additional runtime memory; local-path downloads and tensor-parallel considerations are in [LOCAL_MODELS.md](docs/LOCAL_MODELS.md).

#### Other System One services

```bash
export SYSTEM_ONE_PROVIDER=generic
export SYSTEM_ONE_URL="http://127.0.0.1:8020"
export SYSTEM_ONE_MODEL="your-served-model-id"
# Set SYSTEM_ONE_API_KEY if required; remote URLs also need SYSTEM_ONE_ALLOW_REMOTE=1.
node bin/open-jev-bridge.mjs doctor
```

`generic`, `jev`, `kev`, `laya`, `decider` and `shisa` are provider profiles, not backend launch commands. `shisa` selects the documented vLLM transport by default, or native llama.cpp with `SYSTEM_ONE_SHISA_BACKEND=llamacpp`. The profiles do not replace explicit URL/model settings. Nonsecret examples are in `examples/{jev,kev,laya,decider,shisa}.config.json`; select a file with an **absolute** `OPEN_JEV_BRIDGE_CONFIG` path or copy its settings into the normal user JSON. Exported settings override that file. No `.env` file is auto-loaded.

### 2. Check this repository

Unzip into a permanent directory. The Node runtime needs **Node.js 22.16 or newer**. The full offline test suite also needs **Python 3.10+**, but does not install Laya, Decider, vLLM, or download weights. The automatic installers target **Linux/macOS or WSL**. There are no npm dependencies to fetch and no compilation step is needed to run the checked-in source.

```bash
cd open-jev-bridge
node --version
npm run check
npm test
node bin/open-jev-bridge.mjs doctor  # uses the selected configuration
```

`doctor` makes real `/v1/models` and mixed Noul/Choice/Score requests. It fails when the server or API contract is unavailable. A successful doctor probe is not a full model-quality or host-integration certification.

### 3. Install hooks, MCP and skills for both hosts

Have the actual `claude` and `codex` CLIs available on PATH, then run:

```bash
node bin/open-jev-bridge.mjs install --host both  # or use the explicit backend command above
```

To install only one host, use `--host claude` or `--host codex`. Restart the hosts afterward. **In Codex, open `/hooks` and review/trust the newly installed definitions.** Installation intentionally does not bypass native trust or permission policy. A host without the documented hook capability must be upgraded or used with MCP alone.

The recommended direct mode installs the same runtime, skills and hook behavior as the stable plugin manifests, without depending on an undocumented Codex plugin-install CLI. It uses official `claude mcp add` / `codex mcp add` commands, not ad hoc TOML edits. Existing unowned `open-jev-bridge` MCP registrations or conflicting skill folders are refused rather than overwritten. A failed or inaccessible MCP lookup is not mistaken for an absent server. Reinstalling in the same checkout refreshes owned hooks and pristine skills; new definitions still require host trust. Move to a different path only after uninstalling from the old checkout.

| Host | Direct hook location | Skill location |
|---|---|---|
| Claude | `~/.claude/settings.json` | `~/.claude/skills/system-one-*` |
| Codex | `~/.codex/hooks.json` | `~/.agents/skills/system-one-*` |

Keep the repository and Node executable paths stable after installation. After moving the repository or replacing the Node installation, uninstall/reinstall so stored absolute launch paths remain correct. User settings are merged, not replaced; avoid concurrent manual edits to those files during installation.

## Native plugin alternatives

The root includes `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, the MCP definitions, hooks, skills and an optional reviewer agent. These are provided for native plugin distribution/marketplace workflows as well as the direct installer. Do **not** enable native and direct integrations simultaneously for one host.

### Claude stable native plugin

```bash
node bin/open-jev-bridge.mjs uninstall --host claude   # only when direct mode was installed
# Keep the selected backend's exported SYSTEM_ONE_* settings from Quick start.
node bin/open-jev-bridge.mjs native-claude
```

The command adds this repository's local Claude marketplace and installs `open-jev-bridge@open-jev-bridge-local` through the real Claude CLI. It does not pretend that native installation succeeded when the CLI fails. Inspect the host's plugin/hook/MCP listings after restart. Use Claude's plugin manager to uninstall native installations; the bridge's `uninstall` command owns direct-mode entries only.

### Claude true-compaction function variant — opt-in

The optional function variant is **included ready to use** in `plugins/claude-functions/`. It contains the pure isolated function module and the same MCP, event-tracking, task/subagent-verification and external-screening command hooks. `npm run build` only regenerates this checked-in bundle from the root sources. The upstream function-hook implementation references a supporting Claude runtime (upstream advertises 2.1.274+) and the feature flag below; do not assume availability on every Claude version.

```bash
# Disable/uninstall the stable native plugin or direct Claude integration first.
# Keep the selected backend's exported SYSTEM_ONE_* settings from Quick start.
# The ready-to-use plugin is already bundled; this command refreshes it from root sources before installation.
node bin/open-jev-bridge.mjs native-claude-functions
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude
```

You can also inspect or distribute the ready plugin directly from `plugins/claude-functions/`; no separate build step is required. The function path handles `session.compact` and optionally triggers it from `turn.complete` at 60% reported context usage. By default it preserves the last six messages, keeps dependencies at probability ≥0.5, and requires at least 25% estimated character reduction before replacing history. Otherwise it calls the host's built-in compactor. Unchanged message handles are retained; edited messages are rebuilt without stale handles.

**Use exported `SYSTEM_ONE_URL`, `SYSTEM_ONE_MODEL`, `SYSTEM_ONE_PROVIDER`, and, as needed, `SYSTEM_ONE_API_KEY` and `SYSTEM_ONE_ALLOW_REMOTE` for this variant.** The isolated function runtime cannot read the Node bridge's user JSON file; the same exported environment also reaches the MCP server. Its network implementation is the host's `$.http.fetch`, so Node-only transport guarantees must not be assumed for that path. Native function loading, context replacement and authenticated host behavior were **not executable in the build environment**; run the native acceptance checklist in [TESTING.md](docs/TESTING.md).

### Codex native distribution

The `.codex-plugin/plugin.json` compatibility manifest identifies the bundled Codex hooks and MCP configuration; `skills/` contains portable skill folders. Use the documented local marketplace/plugin workflow for the installed Codex version, or use the recommended `install --host codex` command for automatic direct registration. No invented `codex plugin install` command, forged trust record or unsupported PreCompact message replacement is used.

## Using the tools and hooks

In a host conversation, requests such as these use the bundled skills and tools:

> “Use the configured System One backend to verify these completion claims against the actual diff and test output. Flag unsupported claims.”
>
> “Classify these candidates, and retain uncertain results for review rather than automatically accepting them.”
>
> “Extract the primary reference code verbatim from this document using a bounded pattern.”

The host may namespace MCP tool names; use the tools it actually lists. The bridge never runs a test because a classifier recommends it: the host must perform the real verification and report its result.

For direct CLI use:

```bash
printf '%s\n' '{"claims":["The build passed"],"evidence":"Build finished with exit code 0."}' \
  | node bin/open-jev-bridge.mjs call --name system_one_verify

printf '%s\n' '{"request":"Fix parser validation","diff":"-allow_invalid\n+reject_invalid","tests":"pytest: 12 passed","claims":["The parser tests passed"],"evidence":"pytest: 12 passed"}' \
  | node bin/open-jev-bridge.mjs call --name system_one_gate

# Larger input can be supplied without shell quoting:
node bin/open-jev-bridge.mjs call --name system_one_verify --file verify-input.json
node bin/open-jev-bridge.mjs compact --file canonical-transcript.json
```

CLI evidence is caller-supplied: a string claiming “12 passed” is not independently attested execution. The completion hooks prefer host tool-event observations and use supported transcripts as a fallback. Belay sends bounded/redacted task/final text, edit counts and recent check summaries. **With default automatic patch review enabled, fresh passing checks then trigger a separate combined gate containing bounded observed edit inputs and actual check evidence. Hosted Jev therefore receives this selected content.** No model call is needed for an unchanged explanation-only turn. Incomplete evidence and backend failures are not passing verification. Continuation guards, caps and evidence-based deduplication bound loops; new corrective evidence is rechecked.

Stable PreCompact hooks save a private canonical checkpoint. After built-in compaction, SessionStart receives a small historical excerpt and checkpoint path, not a replacement transcript. This can preserve access to earlier verbatim evidence, but is **not** a claim of directly reducing Codex's active context or eliminating its own compaction cost. Checkpoints contain visible text/tool data, not a serialization of images, private thinking or every host-internal block.

## Configuration

Node runtime precedence: defaults → user JSON → environment → CLI overrides. Default JSON path is `~/.config/open-jev-bridge/config.json`, honoring `XDG_CONFIG_HOME` or `OPEN_JEV_BRIDGE_CONFIG`. State defaults to `~/.local/state/open-jev-bridge`, honoring `XDG_STATE_HOME` or `OPEN_JEV_BRIDGE_DATA`. The installer persists supplied non-secret options but never an API key inherited from the environment.

| Setting | Default | How to change |
|---|---:|---|
| `url` | `http://127.0.0.1:8009` | `--url`, `SYSTEM_ONE_URL`, or JSON |
| `model` | `kev-latest` | `--model`, `SYSTEM_ONE_MODEL`, or JSON |
| `provider` | `generic` | `--provider`, `SYSTEM_ONE_PROVIDER`, or JSON: generic / jev / kev / laya / decider / shisa |
| `shisaTopLogprobs` | `20` | `SYSTEM_ONE_SHISA_TOP_LOGPROBS`; server must allow this top-k |
| `shisaMaxPromptTokens` | `32768` | `SYSTEM_ONE_SHISA_MAX_PROMPT_TOKENS`; also bounded by the actual tokenizer/server limit |
| `shisaNoulTemperature` / `shisaChoiceTemperature` / `shisaScoreTemperature` | `1.0` each | `SYSTEM_ONE_SHISA_NOUL_TEMPERATURE`, `SYSTEM_ONE_SHISA_CHOICE_TEMPERATURE`, `SYSTEM_ONE_SHISA_SCORE_TEMPERATURE` |
| `apiKey` | unset | `SYSTEM_ONE_API_KEY`, for hosted Jev or an authenticated local/private service |
| `apiKeyFile` | unset | `--api-key-file`, `SYSTEM_ONE_API_KEY_FILE`, or JSON; private absolute single-line file |
| `allowRemote` | false | `--allow-remote`, `SYSTEM_ONE_ALLOW_REMOTE=1`, or JSON |
| `timeoutMs` | 20,000 | `SYSTEM_ONE_TIMEOUT_MS` or JSON; installed hooks require ≤20,000 under a 25-second host timeout |
| `maxConcurrent` / `maxQueue` | 2 / 32 | JSON; request concurrency is bounded, not a promise of parallel model inference |
| `retries` | 0 | JSON, at most 2 transient-HTTP retries within the same deadline |
| `aliases` | false | `--aliases`, `SYSTEM_ONE_JEV_ALIASES=1`, or JSON |
| `autoVerify` | true | `SYSTEM_ONE_AUTO_VERIFY`; automatic completion/subagent/task checks |
| `autoReview` | true | `SYSTEM_ONE_AUTO_REVIEW`; patch/completion gate after fresh passing checks; requires autoVerify |
| `autoScreen` | true | `SYSTEM_ONE_AUTO_SCREEN`; bounded matched external-result screening |
| `autoCompaction` | true | `SYSTEM_ONE_AUTO_COMPACTION`; bridge checkpoint/function compaction, not the host compactor |
| `compactAtPercent` | 60 | `SYSTEM_ONE_COMPACT_AT_PERCENT`; optional Claude function usage trigger, not a Codex setting |
| `shadow` | false | `--shadow`, `SYSTEM_ONE_BELAY_SHADOW=1`, or JSON; Stop logs a would-block without enforcing it |
| `belayThreshold` | 0.7 | JSON |
| `maxBlocks` / `blockCooldownMs` | 3 / 60,000 | JSON |
| `maxStateTokens` / `maxRequestTokens` | 6,000 / 7,600 | JSON; conservative UTF-8 byte estimates, **not exact token counts** |
| `preserveRecentMessages` / `keepThreshold` | 6 / 0.5 | JSON for Node paths, or `system_one_compact.options` |
| `truncateHeadChars` / `minReductionRatio` | 300 / 0.25 | JSON for Node paths, or compaction options |
| `maxTranscriptBytes` / `maxCheckpointBytes` | 16 MB / 4 MB | JSON |
| `checkpointTtlMs` | 3,600,000 | JSON; expired files are not restored, but remain on disk until deliberately removed |

All defaults/validators are in `src/config.mjs`. Bad values and unknown keys fail explicitly; hook entry points still fail open. For an intentional private LAN deployment:

```bash
node bin/open-jev-bridge.mjs install --host both \
  --url https://system-one.internal.example:8009 --allow-remote
```

Protect remote deployments with TLS/access controls and a trusted proxy. Do not pass credentials in the URL. A supplied non-loopback URL is rejected without explicit opt-in. Standard Node transport refuses redirects. The default local setup never calls a Jev/TypeSafe service.

## Test results and benchmark

<!-- VALIDATION:START -->
**696/696 Node tests and 67/67 Python adapter tests passed (763 total); zero failures or skips.** Syntax/schema/plugin checks, the coverage run and the benchmark completed with zero exit codes: **PASS**. Recorded 2026-09-24T08:50:35.911Z, v22.16.0, linux/x64. Raw evidence is generated under `reports/` by `npm run validate`; reports are deliberately excluded from the clean source ZIP. **Live Jev/Kev/Laya/Decider/Shisa inference: NOT EXECUTED. Real native-host sessions: NOT EXECUTED.**
<!-- VALIDATION:END -->

The fixture API is a deterministic local HTTP server used to establish request/response wiring. It is **not neural model inference**, and these green tests do **not** prove the model's semantic accuracy. The native host CLIs are explicit doubles in installer/e2e tests. Real model and authenticated native-host acceptance remain separate, clearly labeled gates rather than skipped cases counted as passes.

<!-- BENCHMARK:START -->
| Measured operation | Samples | p50 | p95 | Throughput |
|---|---:|---:|---:|---:|
| direct_http_system_one | 100 | 0.755 ms | 1.404 ms | 1163.3/s |
| stdio_mcp_to_http | 100 | 0.983 ms | 1.599 ms | 943.9/s |
| compaction_pure_fixture | 100 | 0.280 ms | 0.462 ms | 3017.5/s |
| verified_belay_fast_path_no_model | 1000 | 0.005 ms | 0.007 ms | 168373.2/s |
| validate_255_rounded_options | 1000 | 0.016 ms | 0.024 ms | 54153.9/s |
| stop_hook_process_verified_no_model | 10 | 55.460 ms | 57.970 ms | 17.9/s |
| stop_hook_process_automatic_task_review | 10 | 88.928 ms | 95.641 ms | 11.1/s |

Environment: v22.16.0, linux/x64, AMD EPYC 9V74 80-Core Processor, 5 logical CPUs. Fixture compaction reduced serialized canonical characters by **96.63%** (17,899 → 603); this deliberately synthetic result is not a real-model retention benchmark.
<!-- BENCHMARK:END -->

The `stop_hook_process_automatic_task_review` case measures the default Stop review path. The separate `stop_hook_process_verified_no_model` fast-path case explicitly disables automatic patch review. HTTP/MCP measurements include local transport overhead and a deterministic fixture response, **not neural inference latency**. The pure-compaction case uses fixed discard judgments over synthetic tool output: its reduction illustrates mechanics, not expected real-world token savings or preserved-recall quality. The Stop subprocess number includes Node startup and imports; the in-process fast path does not. No cross-provider speed or quality comparison is claimed. Sample counts, warmups, p50/p95/p99, throughput, environment and raw results are recorded in `reports/benchmark.json`.

### Run the suite

```bash
npm run check
npm test
npm run test:unit
npm run test:integration
npm run test:automation  # installed lifecycle commands, event evidence, native-function contract
npm run test:providers   # all provider contracts + Python HTTP/MCP e2e
npm run test:adapter     # Python adapter unit/security/HTTP suite
npm run test:e2e
npm run test:coverage
npm run benchmark
npm run validate       # all offline checks + coverage + benchmarks, saved under reports/
npm run test:providers # all supported provider contracts and cross-process integrations
npm run benchmark:providers # Decider/Shisa adapter overhead only (synthetic responses)
```

The suite tests strict schemas and rounded distributions; HTTP/API integrity and failure handling; every tool's policies; pairing/prose/handle preservation; fresh-check ordering; prompt-like/static output false positives; regex timeouts/cancellation; byte limits/queues/circuit recovery; MCP handshake/errors/Unicode/cancellation; both installer paths/idempotency/rollback/ownership; private state/checkpoint isolation; and a real subprocess pipeline through generated hook/MCP commands. Full coverage mapping and release gates are in [TESTING.md](docs/TESTING.md).

For your **actual** model/server and installed CLIs:

```bash
# First select one complete backend configuration above.
npm run test:live        # all tools + basic semantic and mixed-type probes; fails if unavailable
npm run benchmark:live  # real deployment measurements, separate report
npm run test:hosts      # actual CLI presence, Claude native manifest validation, direct MCP registrations
```

`test:hosts` is a readiness check, not an authenticated conversation test. Complete the native-session checklist before treating a host/version as accepted. No subagent was available during this build; direct source review and regression tests were used. An optional reviewer-agent prompt and `AGENTS.md` provide a repeatable review workflow for a host that supports subagents.

## Repository map

```text
bin/open-jev-bridge.mjs             CLI, MCP launch and hook entry point
src/providers.mjs             Provider limits, rounding profiles and model-list normalization
adapters/laya_server.py       Optional Laya HTTP sidecar; refuses all input truncation
adapters/decider_server.py    Optional Decider 35B eager CUDA sidecar; exact preflight limits
src/shisa.mjs                Pure vLLM restricted-letter translation shared with Claude functions
src/shisa-llamacpp.mjs       Native GGUF tokenizer/template/probability adapter
docs/LOCAL_MODELS.md          Local downloads/serving, complete payload contracts and source audit
examples/                    Jev / Kev / Laya nonsecret configuration files
src/client.mjs                Configured HTTP transport, budgets, queue and breaker
src/schema.mjs                Strict input and typed answer integrity
src/tools.mjs                 Ten task tools + four bridge tools
src/compact.mjs               Pure immutable compaction engine
src/belay.mjs                  Current-turn execution evidence and completion policy
src/transcript.mjs             Claude/Codex record adapters
src/hooks.mjs                 Automatic host lifecycle integration
src/automation.mjs            Event evidence, proactive policy, task gate and screening
src/automation-status.mjs     Offline hook-readiness and observation inspection
src/function-hook.mjs         Optional isolated Claude function adapter
src/install.mjs               Direct installation, ownership, rollback and uninstall
.claude-plugin/               Claude manifest and local marketplace
.codex-plugin/                Codex compatibility manifest
plugins/claude-functions/     Ready-to-use self-contained Claude function-hook plugin
hooks/  skills/  agents/      Host integrations and usage/review guidance
tests/                       Offline unit, contract, integration and subprocess e2e
benchmarks/                  Reproducible offline/live benchmark runner
scripts/                     Build, check, live/host checks and report generation
docs/                        API, source review, testing and native acceptance
```

`plugins/claude-functions/` is checked in and ready to install. `npm run build` deterministically regenerates that self-contained variant from the root implementation when the root runtime changes. The clean release still excludes lockfiles, validation reports, checksums, caches, and unrelated generated build artifacts. `npm run check` validates the source tree. Do not edit files under `plugins/claude-functions/` independently; regenerate them from the root sources.

## Migration from the previous Kev-named release

This is an intentional namespace change, not a hidden alias layer. The previous `KEV_*` bridge environment variables are no longer read. Use `SYSTEM_ONE_*`; `KEV_BRIDGE_CONFIG` becomes `OPEN_JEV_BRIDGE_CONFIG`, and `KEV_BRIDGE_DATA` becomes `OPEN_JEV_BRIDGE_DATA`. MCP tools become `system_one_*`, with `kev_system_one` becoming `system_one_query`. The CLI is `bin/open-jev-bridge.mjs` and the MCP registration is `open-jev-bridge`.

Uninstall the old **direct** integration with its old checkout **before** installing this release, so two Stop hooks do not run:

```bash
node /absolute/path/to/kev-bridge/bin/kev-bridge.mjs uninstall --host both
# Then use this release's backend-specific install command.
```

For old native plugins, disable/remove them through the host's plugin manager. Configuration and private checkpoints are not automatically migrated or deleted. Copy nonsecret JSON values to `~/.config/open-jev-bridge/config.json` deliberately; retarget a key file rather than copying a key into source control. Only optional `jev_*` tool aliases remain, because they explicitly support the upstream tool names; they do not choose Jev or change any credentials.

## Uninstall and troubleshooting

```bash
node bin/open-jev-bridge.mjs uninstall --host both
```

This removes only owned direct-mode MCP entries and exact hook commands. It preserves other settings, user-modified/extended skill folders, configuration and checkpoints. Native installations are managed through the respective host plugin manager. Restore/remove private checkpoint files deliberately; no broad cleanup command deletes your history.

A connection error usually means the selected server is not running at the configured URL. An invalid-response error means the endpoint or answer does not meet the System One contract; a chat-completions URL is not interchangeable. A context-budget error requires a smaller **complete** evidence unit or a model-compatible budget, not deletion of inconvenient facts. Missing hooks can reflect an older host, disabled plugin, stale absolute path or unapproved Codex hook trust. No Stop block may be legitimate: no observed edits, an accepted automatic task review, explicit partial/blocked output, a guard, shadow mode or fail-open on unavailable/incomplete evidence.

A process killed while holding a state lock can leave a lock file. Confirm the owning process is no longer active before removing only that stale lock; the default behavior safely bypasses rather than guessing. See [SECURITY.md](SECURITY.md) for trust boundaries and known limits.

## License

Original bridge code is MIT licensed. Upstream attribution and model-license separation are in [NOTICE](NOTICE). No upstream source archive, model weight, third-party npm runtime or font file is bundled.

## New-provider test coverage

`tests/local-models.test.mjs` checks endpoints, typed payloads, Decider hybrid rounding, Shisa prompt fidelity and restricted-softmax arithmetic, all fourteen tools, missing-letter fallbacks, malformed responses, budgets, authentication, cancellation and concurrency. `tests/local-models-e2e.test.mjs` executes CLI/MCP subprocesses and the actual installed hook commands for **both hosts and both new providers**: edit → Stop verification → real recorded check result → review gate → screening → compaction checkpoint → recovery. It also executes the bundled Claude function callback through both transports.

The Decider tests run the **actual Python HTTP wrapper** with a clearly named fake neural backend, and its Python tests verify eager loading, CUDA/BF16 checks, preflight row limits and private error handling. Shisa fixtures independently implement the required vLLM and llama.cpp wire shapes and deliberately synthetic tokenizers. They are not real vLLM/llama.cpp model or GPU inference measurements. Runtime code never imports fixture backends. See [LOCAL_MODELS.md](docs/LOCAL_MODELS.md) for the exact API/source audit and live acceptance procedure.

<!-- PROVIDER_BENCHMARK:START -->
**Measured adapter overhead only — synthetic HTTP/tokenizer/model fixtures, not GPU inference.** Three typed questions per logical request; 20 measured samples after three warmups. Shisa deliberately exercises two missing-letter fallback reads.

| Provider/transport | p50 | p95 | HTTP calls per logical request |
|---|---:|---:|---:|
| decider/http | 1.087 ms | 2.262 ms | 1 |
| decider/mcp | 1.217 ms | 2.159 ms | 1 |
| shisa/http | 17.101 ms | 19.284 ms | 22 |
| shisa/mcp | 14.083 ms | 17.020 ms | 22 |

Environment: v22.16.0, linux, AMD EPYC 9V74 80-Core Processor. Reproduce with `npm run benchmark:providers`; raw samples are generated under `reports/provider-benchmark.json`. This compares adapter work on fixtures, not model inference speed or decision quality.
<!-- PROVIDER_BENCHMARK:END -->

