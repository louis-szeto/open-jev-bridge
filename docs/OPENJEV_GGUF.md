# OpenJev GGUF — integrated native llama.cpp provider

## Direct deployment (recommended)

The implementation is part of the main repository and its bundled Claude function
plugin. It is not a second downloadable add-on. One llama.cpp process loads the GGUF;
Node performs only the HTTP transport and numerical decision readout.

```text
Claude / Codex MCP or automatic hook
  → SystemOneClient(provider="openjev") / isolated function-hook transport
  → native llama.cpp API on 127.0.0.1:8014
  → locally loaded OpenJev GGUF on the configured device
```

Start a compatible llama-server with the OpenJev model, `--alias openjev`, loopback
binding, an explicit context size, and its model chat template (`--jinja`). The README
includes a download and CUDA example. The bridge never downloads weights or launches
llama.cpp implicitly. An alias selects an already loaded server model; it is not a
Hugging Face checkpoint downloader.

From the repository directory:

```bash
export SYSTEM_ONE_PROVIDER=openjev
export SYSTEM_ONE_URL=http://127.0.0.1:8014
export SYSTEM_ONE_MODEL=openjev
export SYSTEM_ONE_OPENJEV_MAX_PROMPT_TOKENS=8192
unset SYSTEM_ONE_SHISA_BACKEND

node bin/open-jev-bridge.mjs doctor
node bin/open-jev-bridge.mjs install --host both
node bin/open-jev-bridge.mjs automation-status --host both
```

The URL is the **llama.cpp URL**, not the former System One sidecar on port 8013.
Run install only for direct installations, from the same permanent checkout path;
restart clients afterward. An existing native Claude function installation should be
refreshed instead of adding duplicate direct Claude hooks. That runtime uses exported
`SYSTEM_ONE_*` values, not the Node-side saved configuration file. The prebuilt bundle
is included and uses the same implementation as the main client.

Use `SYSTEM_ONE_API_KEY` or `SYSTEM_ONE_API_KEY_FILE` when llama-server requires a
bearer key. Keys belong in the environment or private key file, never `PATH`. Remote
endpoints require `SYSTEM_ONE_ALLOW_REMOTE=1`; credentials over non-local HTTP are not
protected by TLS. Loopback is the default and recommended starting point.

## Input, transport and output

Public tools still accept the common System One request:

```json
{
  "model": "openjev",
  "state": {"message": "The parcel arrived damaged."},
  "questions": {
    "damaged": {"type": "noul", "instructions": "Was the parcel damaged?"},
    "route": {"type": "choice", "instructions": "Choose department", "criteria": {
      "returns": "Damaged goods and replacements", "billing": "Charges and invoices"
    }},
    "urgency": {"type": "score", "instructions": "Rate urgency", "criteria": ["low", "normal", "urgent"]}
  }
}
```

The `openjev` profile translates it as follows. It does **not** post that JSON to an
OpenAI chat endpoint and hope the model generates a schema-conforming answer.

| Native route | What is sent/read |
|---|---|
| `GET /v1/models` | OpenAI-style `data[].id` must contain the configured alias. |
| `GET /props` | The slot's `default_generation_settings.n_ctx`; not total capacity multiplied by slots. |
| `POST /apply-template` | One OpenJev user message, `add_generation_prompt: true`, thinking disabled; read `prompt`. |
| `POST /tokenize` | `content`, `add_special: false`, `parse_special: true`; require actual token IDs. |
| `POST /completion` | Numeric prompt IDs, one generated token, explicitly neutral sampling; read `completion_probabilities`, not sampled text. |

The text inside the model's Qwen chat template is:

```text
State:
<state text or JSON>

Question: <instructions>
Options:
[A] <option key>: <description>
[B] <option key>: <description>

Answer with the letter of the best option only.
```

The renderer must return exactly one Qwen user turn followed by a non-thinking
assistant boundary. The response can include the documented empty, closed thinking
block. Arbitrary template substitutions, an open thinking block, or a changed user
message are rejected. Unlike Shisa, this profile uses OpenJev's Qwen template through
`/apply-template`; the two adapters intentionally do not share their prompt formats.
Literal chat-control markers in supplied evidence/instructions/options are rejected.

Each option letter must be one token, and appending it must leave all preceding prompt
tokens unchanged. Bare letters are preferred; a space-prefixed single-token form is
accepted when it passes the same prefix-stability check. Token IDs are taken from the
served GGUF tokenizer, never hard-coded from a different checkpoint.

The adapter obtains raw option logprobs and applies a restricted softmax at the
configured reference temperature. When a candidate is absent from the returned top
logprobs, a separate equal-bias recovery request places the same bias on all candidate
IDs. A common bias cancels in their normalized distribution. The code validates the
sampling receipt and checks overlapping logit differences; missing, malformed or
underflowed candidate probabilities still fail explicitly. There is no fabricated
zero-probability fallback and generated `content` never determines the answer.

A typed result contains `model`, `answers`, `usage`, and `bridge` metadata:

- `noul`: probability of the **yes** option (yes/no order), followed by reference
  log-odds temperature/bias calibration.
- `choice`: highest-probability caller key, a distribution over every caller key,
  and the reference adjusted-above-uniform confidence formula.
- `score`: expected **zero-based** level index, original legend and distribution,
  and the reference modal-distance confidence formula.

Answers are rounded to four decimals and validated using the corresponding rounding
envelope. Additional metadata reports HTTP/readout/recovery counts, the effective
context limit and `gguf_calibration_validated: false`. This flag is deliberate: reference
constants are not a claim of measured calibration on a quantized GGUF or your workload.

## Limits and known differences from the upstream helper

The direct client accepts up to 512 questions in a logical request, Choice up to 255
options and Score up to 255 levels. Questions are read independently and sequentially.
At most 52 letter labels are used in one readout. Larger sets use a two-stage hierarchy:
score chunks, score their winners, and compose the final distribution. This is an
approximation, not a claim that 255 options were scored in one flat forward pass.
Metadata identifies hierarchical use. Compare performance/quality on your real tasks.

The optional sidecar keeps a smaller default limit of 32 questions per incoming
request. Neither path silently truncates input. Complete rendered prompt plus one
output token must fit the smaller of the configured cap and server per-slot capacity.
All network operations and queue waits share one caller deadline; a question count
limit is not a promise that a large request will finish within a hook's 20-second budget.

This implementation is text-only. It does not add screenshot/projector inference,
prefix-padding experiments or permutation averaging. Structured instructions and state
are serialized as JSON, whereas the published reference profile uses Python repr for
structured instructions. For string instructions the text structure follows the
reference. These differences are explicit rather than described as bit-identical
inference. Do not use the Shisa calibration settings for this profile.

| Environment | Default | Meaning |
|---|---:|---|
| `SYSTEM_ONE_OPENJEV_MAX_PROMPT_TOKENS` | 8192 | Hard complete-prompt cap, also bounded by the server. |
| `SYSTEM_ONE_OPENJEV_MAX_READOUTS` | 1024 | Hard forward/readout request cap including recovery. |
| `SYSTEM_ONE_OPENJEV_TEMPERATURE` | 0.85 | Restricted-option temperature. |
| `SYSTEM_ONE_OPENJEV_NOUL_TEMPERATURE` | 1.829074 | Yes/no log-odds temperature. |
| `SYSTEM_ONE_OPENJEV_NOUL_BIAS` | 0 | Yes/no log-odds bias. |

## Optional System One HTTP sidecar (already included)

Other applications that need a `/v1/systemone` endpoint can still use the merged
sidecar. It delegates to the exact same `openjev` client rather than duplicating the
probability logic. It binds only to numeric loopback, rejects browser origins and
oversized bodies, and bounds concurrent requests.

```bash
OPENJEV_LLAMA_URL=http://127.0.0.1:8014 \
OPENJEV_PORT=8013 OPENJEV_MODEL=openjev \
OPENJEV_MAX_PROMPT_TOKENS=8192 npm run serve:openjev
```

For this optional topology only, the bridge/client uses:

```bash
export SYSTEM_ONE_PROVIDER=generic
export SYSTEM_ONE_URL=http://127.0.0.1:8013
export SYSTEM_ONE_MODEL=openjev
```

`OPENJEV_TOKEN` authenticates clients to this optional adapter; `OPENJEV_UPSTREAM_TOKEN`
authenticates the adapter to llama.cpp. They are independent. Other sidecar environment
parameters remain visible in `adapters/openjev-llamacpp.mjs`. Do not run the sidecar or
listen on 8013 when using the direct profile unless another application needs it.

## Tests and acceptance

```bash
npm run test:openjev      # explicit fake tokenizer/model, real local HTTP/subprocesses
npm run validate         # full repository gate, Python, coverage, benchmarks
node bin/open-jev-bridge.mjs doctor  # actual selected server; no silent mock fallback
npm run test:live
npm run benchmark:live
```

`tests/openjev-direct.test.mjs` covers the provider, typed requests, all fourteen tools,
actual MCP/CLI processes, persisted installation settings, automatic hooks, the bundled
Claude function plugin, auth, deadlines and cancellation. `openjev-sidecar.test.mjs`
covers the optional HTTP layer and numerical/template failures; fixtures are in
`tests/fixtures/openjev-http.mjs`. Offline tests do not run real weights, a GPU or
native authenticated Claude/Codex clients.

For long **manual** experiments, prefix one command with
`SYSTEM_ONE_TIMEOUT_MS=120000`; do not export that globally for installed hooks.
Installation caps hook request budgets at 20 seconds. If the model cannot respond
within that budget, reduce task size/context or use a faster serving configuration;
API contract correctness alone does not establish practical hook latency.

## Sources and licensing

- Model/files: https://huggingface.co/openjev/openjev-GGUF
- Reference server: https://github.com/abhishekgahlot2/openjev-server
- Prompt: `openjev_server/prompt.py`, reviewed blob `b136993ca81140d8d6134349fc80e7361eb18b27`.
- Readout: `openjev_server/readout.py`, reviewed blob `a33863c5e864f9f143743f93068a4cd80fa9efdc`.
- Profile: `profiles/openjev.json`, reviewed blob `f97506f3ad9ff3c56b767b2ecf1b1bf04267fc4d`.
- Native API: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md

Modified reference-derived code carries Apache-2.0 attribution. Its LICENSE and NOTICE
are included under `licenses/` in both the source repository and ready-to-use function
bundle; the remainder retains its applicable existing notices. No model weights ship.
