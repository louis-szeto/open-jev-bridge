# Shisa DE-1 GGUF with llama.cpp

Added in **0.4.1**, with the raw-scaffold fix in **0.4.2**. This is a separate, explicit serving backend for the existing
`shisa` provider. It does not turn arbitrary GGUF/chat models into Shisa decision
models. Model inference runs in your existing local `llama-server`; the bridge
needs neither Python nor downloaded tokenizer files for this integration.

## Fix for `served GGUF chat template differs from the documented Shisa scaffold`

The v0.4.1 guard compared `/apply-template` output against the fixed Shisa prompt.
That conflated a server's general-purpose chat rendering with this decision model's
readout contract. The error establishes a token-level mismatch; it does not tell us
which template setting differs or establish that the model weights failed to load.
Adding `--jinja` alone is not a reliable diagnosis, and is unnecessary for the fix.

**0.4.2 renders the documented Shisa scaffold in the bridge, tokenizes it with the
served GGUF, validates its control tokens and answer boundary, and sends that exact
numeric sequence to native `/completion`.** This endpoint accepts token-ID input;
there is no server-side chat-template application and no implicit extra BOS for an
integer-only prompt. The bridge neither accepts the differing template nor relaxes
the restricted-letter probability checks. `/apply-template` is no longer used or
required by the llama.cpp adapter. The separate vLLM adapter is unchanged.

Use the update instructions below in your existing checkout, leaving the server,
GGUF and GPU configuration unchanged. `doctor` now reports the prompt source and
successful control-token validation. Failure to tokenize the Shisa/Gemma markers
correctly remains an error; there is no `skip_validation` option. This is still
Shisa-specific and cannot certify that a compatible tokenizer accompanies the
correct weights; choose the correct checkpoint and separately evaluate quality.

## Fix for `shisa: missing tokenizer tokens`

The 0.4.0 Shisa adapter was vLLM-only. vLLM's `/tokenize` accepts `prompt` or
`messages`; llama.cpp's route accepts `content`. A llama.cpp response containing
only `{"tokens": []}` to all three old diagnostics is therefore not a missing
model download or a CUDA problem. Do not disable validation or add a fabricated
`count`: template and completion APIs differ too.

Use the 0.4.2 source in the **same directory** from which you installed the bridge.
A new checkout path conflicts with the existing installation receipt. Preserve
local configuration. Do not run direct installation if you use the native Claude
plugin variant instead.

Keep your current Shisa GGUF server running on `127.0.0.1:8012`. From the bridge:

```bash
export SYSTEM_ONE_PROVIDER=shisa
export SYSTEM_ONE_SHISA_BACKEND=llamacpp
export SYSTEM_ONE_URL=http://127.0.0.1:8012
export SYSTEM_ONE_MODEL=shisa-de-1
export SYSTEM_ONE_SHISA_MAX_PROMPT_TOKENS=8192

# Check the actual API, scaffold controls, option tokens and all three answer types.
node bin/open-jev-bridge.mjs doctor

# Existing direct installations: save settings for hooks and refresh owned files.
node bin/open-jev-bridge.mjs install --host both
node bin/open-jev-bridge.mjs automation-status --host both
```

Restart the host/MCP processes afterward. For the optional native Claude function
plugin, update the existing local-marketplace installation with
`claude plugin update open-jev-bridge-functions@open-jev-bridge-local --scope user`
**instead of direct installation**. For a first native install, use
`node bin/open-jev-bridge.mjs native-claude-functions`. Start a new Claude process
from a shell exporting the same values and `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1`. The function plugin cannot
read the Node runtime's saved JSON config; its MCP/command components and isolated
functions both need the chosen backend. Do not enable both integration modes.

`shisaBackend: "llamacpp"` is the corresponding JSON config property.
`--shisa-backend llamacpp` is accepted by the CLI. `llama.cpp` is also accepted as
an alias and canonicalized to `llamacpp`. Default remains `vllm`, to preserve
existing deployments. There is no silent backend auto-detection or cloud fallback.

Optional minimal server example (retain your own GPU/thread/batch flags):

```bash
/mnt/md0/llama.cpp/build/bin/llama-server \
  -m /absolute/path/to/shisa-de-1.IQ4_XS.gguf \
  --host 127.0.0.1 --port 8012 \
  --alias shisa-de-1 -ngl 999 -c 8192
```

`--alias` gives a readable model-list name; the native single-model routes do not
require that alias. `--jinja` and `--chat-template-file` only affect other chat
consumers and are not prerequisites for this raw-token path. The bridge does not
alter GPU, NUMA, KV-cache or flash-attention
settings. The supported mode is a **single loaded model**, not llama.cpp's dynamic
multi-model router. Quantized GGUF accuracy/calibration is not assumed identical to
the BF16 checkpoint. Re-evaluate thresholds on your workload.

Local authentication is optional; when enabled on the server, configure
`SYSTEM_ONE_API_KEY` or the bridge's private key-file mechanism. Clear obsolete
keys and key-file settings before switching from an authenticated remote provider.

## Actual wire contract

| Route | Request | Validated result |
|---|---|---|
| `GET /v1/models` | No body | OpenAI-style `data[].id`; used for discovery/status |
| `GET /props` | No body | `default_generation_settings.n_ctx`: **per-slot** context limit |
| `POST /tokenize` | `{content, add_special: false, parse_special: true, with_pieces: false}` | Nonempty integral `tokens` array; no vLLM `count` or `max_model_len` requirement |
| `POST /completion` | Numeric prompt IDs, `n_predict: 1`, `stream: false`, explicit neutral samplers, `n_probs` | Native `completion_probabilities[0].top_logprobs`, token IDs, untruncated prompt counts |

The bridge always renders the system instruction, JSON user payload, and
non-thinking generation boundary from Shisa's published text-only scaffold. Angle
brackets in payload strings are JSON-escaped, preserving the data but preventing
embedded control markers. The served tokenizer must encode each of `<bos>`,
`<|turn>`, `<turn|>`, `<|channel>`, and `<channel|>` as one distinct token. Their IDs
are discovered once per logical request; no GGUF-specific numeric IDs are assumed.
Their occurrences in the full prompt must be exactly:

```text
BOS, open-turn, end-turn, open-turn, end-turn, open-turn, open-channel, end-channel
```

The first and last tokens must be BOS and end-channel respectively. Duplicate BOS,
missing controls, changed order or extra tokens beyond the answer boundary fail
before inference. Each option letter must then tokenize to one distinct token
separate from those controls, and `prompt + letter` must preserve all prompt IDs
and append only that token. The full prompt plus one prediction must fit the
smaller of the server's per-slot limit and bridge budget. Four slots of 8,192
tokens are **not** one 32,768-token context. Server-side truncation, changed prompt
counts, missing probability rows and invalid IDs still fail explicitly.

`content` and the sampled token are never used as the answer. Noul uses A=Yes,
B=No. Choice and the bridge-defined Score readout use the same restricted-letter
normalization as the existing vLLM adapter. The limit remains 26 options/levels.

### Missing-letter recovery without invented prompt-logprob support

llama.cpp does not provide vLLM's forced-prompt-logprob contract. First, the bridge
requests native **pre-sampling** logprobs with `post_sampling_probs: false`. If all
option IDs occur in the returned top-N rows, it restricts and normalizes those rows.

If any option is missing (or represented by llama.cpp's float-underflow sentinel),
it makes **one** recovery request at the same prompt boundary. It adds the **same
finite logit bias, +80, to every option token**, uses `temperature: 1`, disables
truncating/penalty samplers and grammar, and requests `post_sampling_probs: true`.
It checks the echoed sampler settings and equal-bias list, then reads **every**
option from `top_probs` using numeric token IDs. No option may be missing or zero;
otherwise the request fails. It never mixes raw and recovered normalizers.

This is a bridge-derived alternative to forced prompt scoring, not a feature
claimed by the Shisa model card. For original option logits `l_i`, a common bias
`b`, and the full-vocabulary normalizer `Z_b`, returned option probabilities are
`p'_i = exp(l_i + b) / Z_b`. Restricting them to the option set `O` gives:

```text
p'_i / sum(j in O, p'_j)
  = exp(l_i + b) / sum(j in O, exp(l_j + b))
  = exp(l_i) / sum(j in O, exp(l_j)).
```

Thus both the common bias and the normalizer cancel. This does not force a winner
or assign a probability to an unobserved option. Finite-precision inference still
applies. When two or more original option rows are available, their logprob gaps
must agree with the recovered gaps within 0.001; an inconsistent recovery fails.
Changing top-p, temperature, grammar, individual biases, or penalties would break
this reasoning, so the recovery validates the response's actual settings rather
than assuming the server obeyed. Native sampled text remains irrelevant.

## Troubleshooting

The old diagnostic can be replaced with this one-route check:

```bash
curl -sS http://127.0.0.1:8012/tokenize \
  -H 'content-type: application/json' \
  -d '{"content":"A","add_special":false,"parse_special":true}'
```

A nonempty integer token array confirms this route, but not complete integration;
run `doctor` next. `/props` is read-only and does **not** require enabling mutable
`--props` configuration. For the old template mismatch, upgrade to 0.4.2; do not
remove checks manually or switch to a guessed template. A current probe should
report `prompt_source: "documented-shisa-scaffold"` and
`control_tokens_validated: true`. If the old error still appears, an older Node
process or cached native Claude function bundle is still running. Unsupported older
native completion envelopes fail with a specific error; use a current llama.cpp
build that supports native pre/post-sampling probability output.

`doctor` now reports `shisa_backend`. If it still shows `vllm`, the MCP process was
not restarted, the backend setting was not saved/exported, or an explicit CLI
flag overrides it. Direct installation persists nonsecret backend settings;
native Claude functions require environment values in their launching shell.

## Tests and limitations

```bash
npm run test:llamacpp       # Native contract + CLI/MCP + installed hooks + function bundle
npm test                   # All providers and Python sidecar regressions
npm run validate           # Syntax, schemas, tests, coverage and benchmarks

# Actual local deployment, not an offline fixture:
node bin/open-jev-bridge.mjs doctor
npm run test:live
```

The independent HTTP fixture reproduces the reported `tokens: []` failure for a
vLLM-shaped request, plus a changed or missing `/apply-template` endpoint. It uses
synthetic single-token Gemma controls and codepoints for other text, not a real
GGUF tokenizer. It emulates llama.cpp's native envelopes and computes a
full-vocabulary softmax oracle independently of the production adapter. Tests
exercise all fourteen tools, all three answer types, 26-option recovery, random
probability vectors, malformed settings, authentication, prefix paths, deadlines,
cancellation, concurrency, installer persistence, automatic Claude/Codex hook
sequences and the ready-to-use Claude function bundle. Both automatic paths are
exercised with a mismatched or unavailable chat renderer. New tests verify strict
control-token order, single-token controls, exact raw prompt submission, unchanged
JSON evidence, and no `/apply-template` call in CLI/MCP or hook execution.

**Not tested here:** the user's running llama-server, this exact GGUF's real token
IDs/template, GPU inference, quantization accuracy, or authenticated native-host
sessions. HTTP and subprocess tests are real, but model/tokenizer outputs and host
CLIs are explicit test doubles. Passing them does not certify those live systems.

## Sources inspected

- [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/53ed051ce5e8193652e449f43216ca3859454f49/tools/server/README.md): tokenize, apply-template, props, native completion, logit bias and probability output.
- [Native result serialization](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/server-task.cpp), inspected blob `0d3beb313ceabbb903de57d185140a8e5a079e4b`: token IDs, pre/post field names, bias receipts, truncation and token counts.
- [Sampling implementation](https://github.com/ggml-org/llama.cpp/blob/master/common/sampling.cpp), inspected blob `06dea1e1ccea368f685fdcd1fcb57774aea9ff24`: logit-bias application and explicit sampler chain.
- [Shisa DE-1 model card](https://huggingface.co/shisa-ai/shisa-de-1): fixed scaffold, single-token/prefix stability, restricted next-token readout, confidence/calibration limitations.

### Template-fix source review (0.4.2)

- [Shisa canonical chat template](https://huggingface.co/shisa-ai/shisa-de-1/blob/main/chat_template.jinja), file commit `a948730`: one system/user turn, BOS and non-thinking generation suffix. The bridge's existing text-only scaffold matches that subset; it does not implement tools, multimodal turns or general chat rendering.
- [llama.cpp native completion and tokenization API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md): integer prompt arrays, BOS insertion conditions, `content`, `add_special`, `parse_special`, and the separate optional `/apply-template` route. Reviewed 2026-09-24.
- No live `/apply-template` output from the user's server was provided. Tests reproduce plausible differing renderings and unavailable routes without claiming any particular difference was observed in that GGUF.
