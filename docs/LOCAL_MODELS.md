# Decider 35B and Shisa DE-1: local serving and adapter contracts

Added in Open Jev Bridge 0.4.0. Research date: 2026-09-24. This document separates the **model checkpoint**, its **serving implementation**, the **bridge translation**, and the **tests actually executed**. A Hugging Face repository is not an inference URL. No model weights are shipped in this ZIP.

## Supported routes

| Profile | Inference route | Input | Result consumed by the bridge |
|---|---|---|---|
| `decider` | `POST /v1/systemone` | `{model,state,questions}` | Native typed `{model,answers,usage}` |
| `shisa` | `POST /v1/completions` plus `POST /tokenize` | Tokenized chat scaffold and one-token logprob requests, one question per readout | Restricted option-letter probabilities, converted into the common typed answer envelope |

Both expose all fourteen existing tools within their stated option/context limits. All existing completion, review, screening and checkpoint hooks use the shared client. The optional Claude function plugin imports the same pure provider, endpoint, schema and Shisa translation modules. No separate LLM chat agent, generated JSON parser or cloud fallback is introduced.

## Mapika/decider-35b-a3b

### Why use the bundled eager wrapper

The [35B model card](https://huggingface.co/Mapika/decider-35b-a3b) instructs callers to load `Decider(..., use_graphs=False)` for this MoE checkpoint. Its BF16 weights are approximately 65 GB; the card calls for an 80 GB-class GPU. Active parameter count is not the amount of VRAM required. This release does not claim that the upstream dense-model graph engine, FP8 helper, CPU offload or untested quantizations work for this checkpoint.

`adapters/decider_server.py` is a small loopback-only HTTP wrapper around the actual `decider.infer.Decider` Python API. It explicitly disables CUDA graphs, requires an available BF16-capable CUDA device, loads the checkpoint once and serializes inference. It reuses the bounded standard-library HTTP plumbing of the Laya sidecar but **does not load Laya**.

The upstream `decider.serve` also has a native System One route. An already-working deployment of that route can be used directly. Its `/decide` route is a different interface (`context`, `schema`, `bool`, `scale`); this bridge deliberately does **not** send System One bodies to `/decide` or guess a conversion.

### Local download and launch

Use a dedicated Python 3.11+ environment with a CUDA-compatible PyTorch stack. The following pins the inspected Python inference implementation; model download is explicit and can use any directory you own.

```bash
# From the open-jev-bridge repository root:
python3 -m venv .venv-decider
. .venv-decider/bin/activate
python -m pip install --upgrade pip
python -m pip install 'git+https://github.com/Mapika/decider.git@b44b4c9880a67291206499b86aac89004850134a'

# Optional explicit download. Otherwise --checkpoint may be the Hugging Face ID.
mkdir -p /mnt/md0/models/decider-35b-a3b
hf download Mapika/decider-35b-a3b --local-dir /mnt/md0/models/decider-35b-a3b

CUDA_VISIBLE_DEVICES=0 python -m adapters.decider_server \
  --checkpoint /mnt/md0/models/decider-35b-a3b \
  --model decider-35b-a3b --device cuda --host 127.0.0.1 --port 8011
```

The wrapper does not automatically distribute a model over several GPUs. Its public alias is defined by `--model`; the checkpoint location is defined by `--checkpoint`. `HF_HOME=/your/cache` can redirect any required Hugging Face cache. Test CUDA before loading; insufficient VRAM or incompatible native kernels are startup errors, not a signal to silently use CPU or a fixture.

In another shell, at the bridge root:

```bash
unset SYSTEM_ONE_API_KEY SYSTEM_ONE_API_KEY_FILE
export SYSTEM_ONE_PROVIDER=decider
export SYSTEM_ONE_MODEL=decider-35b-a3b
export SYSTEM_ONE_URL=http://127.0.0.1:8011
export SYSTEM_ONE_ALLOW_REMOTE=0
node bin/open-jev-bridge.mjs doctor
node bin/open-jev-bridge.mjs install --host both
```

To authenticate the wrapper, export the same `SYSTEM_ONE_API_KEY` in **both** shells before launching. Existing configured `apiKeyFile` values must also be cleared when switching to an unauthenticated backend. The wrapper is not a public internet server; use a deliberately authenticated TLS proxy for remote access.

### Exact contract and limits

- Choice: 2–255 named options. Score: 2–10 ordinal levels. Noul: probability of the `true` answer. Instructions/criteria may carry structured JSON; normal built-in tools use explicit instructions.
- Native probability values and confidence are serialized to four decimal places, but the expected ordinal **score is rounded to two**. The `decider` profile validates these independently. It also checks that reported confidence matches the provider's maximum-probability statistic. It does not “fix” a malformed probability sum by renormalizing it.
- `/v1/models` uses `models[].name`; it is normalized to `id`. The upstream response's versioned model name need not equal a requested alias.
- `certainty`, `level_fit`, `fit_mass` and usage metadata may be present. They are not treated as commands, proof, or replacements for the main answer probabilities. `confidence` is the provider's maximum option probability, not Jev's confidence formula.
- The bundled wrapper retains independent question evaluation and the checkpoint's isolated-score behavior. It uses the checkpoint's plain/state-first layout and rejects a different layout explicitly.
- Upstream prompt construction slices state. The wrapper first tokenizes the **actual rendered state with the `Context:\n` prefix** and rejects anything over its budget. It then uses the inspected `_system_one_items` preflight helper to bound expanded rows, each full row and total request tokens. This helper is deliberately pinned and checked at startup; an incompatible future package is not silently accepted.

Wrapper defaults: `--max-state-tokens 32768`, `--max-row-tokens 36864`, `--max-request-tokens 131072`, `--max-rows 1024`, `--max-fwd-tokens 8192`. The forward-token value is an upstream batching target; a single permitted row can exceed that target, so it is **not a hard VRAM guarantee**. Decrease input budgets for constrained hardware. A concurrent inference receives 429; invalid/oversized semantic inputs receive 422; the HTTP byte limit is 1 MB. Client cancellation stops waiting, not an already executing CUDA kernel.

## shisa-ai/shisa-de-1

### Launch vLLM, not a System One sidecar

The [model card](https://huggingface.co/shisa-ai/shisa-de-1) describes a restricted next-token letter readout through vLLM. This is not a server that accepts `{state,questions}` at `/v1/systemone`. Use a vLLM build that supports this Gemma model and the tokenization/completion fields documented below. Its weights are approximately 48.1 GiB before runtime/cache overhead; choose sufficient GPU memory or a supported tensor-parallel deployment.

```bash
# Use a separate vLLM environment with CUDA-compatible dependencies.
# The model card specifies mainline vLLM; serving dependencies are not Node dependencies.
python3 -m venv .venv-shisa
. .venv-shisa/bin/activate
python -m pip install --upgrade pip
python -m pip install vllm huggingface_hub

mkdir -p /mnt/md0/models/shisa-de-1
hf download shisa-ai/shisa-de-1 --local-dir /mnt/md0/models/shisa-de-1

CUDA_VISIBLE_DEVICES=0 vllm serve /mnt/md0/models/shisa-de-1 \
  --served-model-name shisa-de-1 --host 127.0.0.1 --port 8012 \
  --dtype bfloat16 --max-model-len 32768 --max-logprobs 30 \
  --logprobs-mode raw_logprobs --generation-config vllm
```

For two compatible GPUs, choose `CUDA_VISIBLE_DEVICES=0,1` and append `--tensor-parallel-size 2` after confirming that the selected vLLM version/hardware supports this model. A matching served tokenizer and the model's published `chat_template.jinja` are essential. Do not replace the template with a generic Qwen template. These launch commands were checked against upstream interfaces, **not executed with GPU weights in this build environment**.

Bridge configuration, from another shell:

```bash
unset SYSTEM_ONE_API_KEY SYSTEM_ONE_API_KEY_FILE
export SYSTEM_ONE_PROVIDER=shisa
export SYSTEM_ONE_MODEL=shisa-de-1
export SYSTEM_ONE_URL=http://127.0.0.1:8012
export SYSTEM_ONE_ALLOW_REMOTE=0
node bin/open-jev-bridge.mjs doctor
node bin/open-jev-bridge.mjs install --host both
```

`SYSTEM_ONE_URL` may also end with `/v1` or `/v1/completions`; the adapter resolves sibling `/v1/models` and `/tokenize` routes correctly, including an explicit reverse-proxy prefix. Local bearer authentication is supported when your serving endpoint is configured for it; the bridge sends the same header on all three routes.

### Translation and readout, step by step

1. Each System One question becomes one independent prompt: the published fixed system instruction plus a user JSON document containing `evidence`, `criterion`, and letter-labelled `options`. No question IDs are used as semantic input. Literal template delimiters inside the JSON are escaped without changing the decoded data.
2. The adapter asks the **served** `/tokenize` endpoint to render the system/user messages with `enable_thinking: false`. It compares those token IDs against tokenization of its rendering of the published text-only scaffold. A changed template fails explicitly.
3. Every used letter `A`–`Z` is checked to be a single token. Appending the letter must produce exactly `prompt_tokens + [letter_token]`, with no retokenized prefix. The complete prompt and fallback reserve must fit both the server's context limit and the configured bridge budget. Nothing is truncated.
4. It posts the verified token IDs to `/v1/completions` with `max_tokens: 1`, `temperature: 0`, `logprobs: 20`, `add_special_tokens: false`, and token-ID-keyed logprob reporting. **`choices[0].text` is ignored**, even when the sampled token is a valid-looking answer. Out-of-option tokens are ignored without being merged or trimmed into option letters.
5. When a requested letter is missing from top-k, it appends that verified letter token and makes a forced-prompt request with `prompt_logprobs: 0` and `return_token_ids: true`. It checks the echoed prompt IDs and takes the last prompt token's logprob. An absent or malformed fallback is an error, not zero probability.
6. It applies stable softmax to just the valid option logprobs. Noul uses **A=Yes, B=No**, reporting the Yes probability. Choice maps the winning letter back to the caller's original ID. For Score, the bridge defines the expected zero-based ordinal index and returns the original legend.

The Shisa model card explicitly documents Choice/Noul readout. The Score conversion and `confidence = max(restricted probabilities)` are **bridge-defined compatibility policies**, not a claim that Shisa publishes Jev-equivalent score confidence. Default readout temperatures are 1.0. Optional per-type temperatures are configurable; calibrate and set automation thresholds using your own task data rather than assuming cross-model equivalence.

### Required vLLM payloads

Chat tokenization uses `{model,messages,add_generation_prompt:true,add_special_tokens:false,chat_template_kwargs:{enable_thinking:false}}`. Plain-tokenization probes use `{model,prompt,add_special_tokens:false}`. The response must supply `tokens`, matching `count`, and `max_model_len`.

Completion requests use numeric `prompt` token arrays, `n:1`, `stream:false`, and `return_tokens_as_token_ids:true`. A normal response needs exactly one `choices` entry with `index:0`, `logprobs.top_logprobs[0]`, and nonnegative integral usage counts. Missing-letter requests additionally require `choices[0].prompt_token_ids` and `choices[0].prompt_logprobs`; the final row is keyed by the appended numeric token ID and contains its `logprob`. `/v1/models` uses the OpenAI shape `{object:"list",data:[{id:...}]}`. A `/v1/chat/completions` response is not substituted for this contract.

Use **raw logprobs**, not processed sampling probabilities or raw logits. Keep vLLM's max-logprobs setting at least the bridge's requested top-k. Unsupported older proxy/server implementations fail closed with a transport/contract error; the bridge does not fabricate compatibility.

### Limits and settings

| JSON configuration key | Environment variable | Default |
|---|---|---:|
| `shisaTopLogprobs` | `SYSTEM_ONE_SHISA_TOP_LOGPROBS` | 20 |
| `shisaMaxPromptTokens` | `SYSTEM_ONE_SHISA_MAX_PROMPT_TOKENS` | 32768 |
| `shisaNoulTemperature` | `SYSTEM_ONE_SHISA_NOUL_TEMPERATURE` | 1.0 |
| `shisaChoiceTemperature` | `SYSTEM_ONE_SHISA_CHOICE_TEMPERATURE` | 1.0 |
| `shisaScoreTemperature` | `SYSTEM_ONE_SHISA_SCORE_TEMPERATURE` | 1.0 |

The current readout supports **at most 26 Choice options or Score levels**, including explicit escape-hatch candidates. Larger sets are rejected before HTTP. No automatic shortlist, option dropping, AA labels, or incorrect global ranking assembled from independent softmax batches is introduced. Large `find`/`classify` catalogs must be explicitly narrowed or sent to another supported backend.

One Node-client deadline covers tokenization, all independent questions, semaphore waits and fallback reads. Bounded concurrency applies across HTTP requests. A failure produces no partially approved compaction. The isolated Claude function API uses only its inspected `{method,headers,body}` fetch fields: its host owns in-flight I/O cancellation; an elapsed deadline prevents further reads and late compaction commits. The bridge does not claim a native cancellation API that was not verified.

Nonsecret tuning is persisted by the direct installer. For the isolated Claude function plugin, export the same `SYSTEM_ONE_*` values in the shell launching Claude; it cannot read the Node-side JSON config/key file. Restart existing MCP/host processes after switching providers. The `system_one_status`/`doctor` probe is an API-shape check, not a declaration that all hook events fired or that a model is accurate.

## Source audit

| Source | Inspected identifier / role |
|---|---|
| [Mapika model card](https://huggingface.co/Mapika/decider-35b-a3b) and [config](https://huggingface.co/Mapika/decider-35b-a3b/blob/main/decider_config.json) | Checkpoint `35b-a3b-v1`; model-card tree `d9783c5`; BF16 eager requirement, plain/default layout, isolated levels, state cap |
| [Decider System One mapping](https://github.com/Mapika/decider/blob/b44b4c9880a67291206499b86aac89004850134a/decider/systemone.py) | Git blob `02b1d1849f8dc91b5b74a6e496ffaaaf51ef280b`; type limits, confidence, probability/score rounding and optional metadata |
| [Decider inference](https://github.com/Mapika/decider/blob/b44b4c9880a67291206499b86aac89004850134a/decider/infer.py) | Blob `36673f87c22064d4cc486d5b1e1e98fbb7a916d8`; eager load, public `system_one`, pinned preflight helper |
| [Decider prompt](https://github.com/Mapika/decider/blob/b44b4c9880a67291206499b86aac89004850134a/decider/prompt.py) | Blob `6df731b07d84b3af81d749fd524f2933476ee4e4`; full row construction and state-prefix truncation |
| [Decider HTTP](https://github.com/Mapika/decider/blob/b44b4c9880a67291206499b86aac89004850134a/decider/serve.py) | Blob `279dd9df2531d1a38d34eed83b3f110c1ebb1e2f`; native routes, models-name envelope, overload/size handling |
| [Shisa model card](https://huggingface.co/shisa-ai/shisa-de-1) and [chat template](https://huggingface.co/shisa-ai/shisa-de-1/blob/main/chat_template.jinja) | Inspected model tree `9111f47`; restricted-letter scaffold, Yes/No ordering, missing-letter fallback, 26-letter scope |
| [vLLM tokenize protocol](https://github.com/vllm-project/vllm/blob/153f2ba1b986fb461d84ae7b4f9644a608f36bc8/vllm/entrypoints/serve/tokenize/protocol.py) | Blob `130a1b4b45c4dae2ad436bc8adc9db979832423f`; chat/text tokenization requests, token IDs/count/model limit |
| [vLLM completions protocol](https://github.com/vllm-project/vllm/blob/153f2ba1b986fb461d84ae7b4f9644a608f36bc8/vllm/entrypoints/openai/completion/protocol.py) | Blob `bf0a94eea7161e6de8ec37006807126b64937417`; numeric prompts, top logprobs, prompt logprobs and returned token IDs |
| [vLLM V1 guide](https://github.com/vllm-project/vllm/blob/153f2ba1b986fb461d84ae7b4f9644a608f36bc8/docs/usage/v1_guide.md) | `--logprobs-mode raw_logprobs` and the distinction from processed probabilities/logits |

These references document interfaces; they do not mean a live endpoint was exercised. Moving branch/model URLs can change. Follow explicit errors and rerun acceptance before upgrading a serving implementation.

## Tests and acceptance

`tests/local-models.test.mjs`: pure numeric readout, prompt/data preservation, endpoint normalization, provider option bounds, hybrid rounding, all 14 tools against HTTP fixtures, forced fallback integrity, authentication, cancellation, deadline and concurrency cases.

`tests/local-models-e2e.test.mjs`: real subprocess MCP and CLI; the actual Python Decider HTTP wrapper with a declared synthetic agent; installed Claude/Codex hook commands through prompt/edit/Stop/check/gate/screen/PreCompact/recovery; bundled native function callback -> transport -> history replacement. Host executables are test doubles, not authenticated vendor-client sessions.

`tests/python/test_decider_adapter.py`: public wrapper contract, boundary token budgets, expanded rows, graph/layout rejection, explicit CUDA/BF16 loader checks, no implicit fallback, model alias/authentication, overload, private error handling and actual HTTP.

```bash
npm run test:providers          # Both new providers plus existing provider regressions
npm run test:adapter            # Laya + Decider Python sidecars, offline fake inference only
npm run validate               # Full suite, coverage and benchmarks
npm run benchmark:providers    # Local transport/adapter overhead; NOT GPU performance

# With a real selected backend running:
node bin/open-jev-bridge.mjs doctor
npm run test:live
npm run benchmark:live
npm run test:hosts
```

Fixtures never appear on production loading paths. Actual Decider/Shisa GPU inference and authenticated Claude/Codex runs were **not executed** in this build environment. Model-quality thresholds, real inference throughput, VRAM fit and native-client loading remain deployment acceptance checks. No missing prerequisite is counted as a successful live test.
