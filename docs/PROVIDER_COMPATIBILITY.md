# System One provider compatibility audit

Checked against official documentation and source during this build (2026-09-23).
No subagent runner was available; source inspection and automated regression tests were performed directly. This document distinguishes **contract compatibility** from **model quality** and **actual inference acceptance**.

## Sources and exact inspected identifiers

| Source | Evidence used |
|---|---|
| [TypeSafe API](https://docs.typesafe.ai/api) | `POST /v1/systemone`, bearer authentication, request/answer primitives, Score 2–10 levels, 429/529 errors |
| [TypeSafe models](https://docs.typesafe.ai/models) | `GET /v1/models` returns `models` entries with `name`, description and release date; aliases may resolve to a versioned response model |
| [Laya model card](https://huggingface.co/convaiinnovations/laya) | Python loading, root/subfolder checkpoints, 512/1,024 default context, limitations |
| [Laya agent.py](https://github.com/NandhaKishorM/laya/blob/main/laya/agent.py) | Inspected Git blob `15e2eb5666f4d3a06592baa1f1b4d1c4abcb340f`; `system_one`, `predict` alias, four-decimal answers, extra `action`, zero output tokens, structured score legends |
| [Laya common.py](https://github.com/NandhaKishorM/laya/blob/main/laya/common.py) | Inspected Git blob `fb900053da691e18ff320d28d4664b46ab0d247f`; question/options head and state truncation in `build_sequence` |
| [Kev api.py](https://github.com/jaredpalmer/kev/blob/main/kev/api.py) | Current inspected Git blob `466089e8c82952cc1c5b86889f07c64d65358ca4`; four-decimal `round_prob`, typed answer mappings. The earlier release inspected blob `3872906b18e01faed904aac848a795ac558e3f31`, which rounded to two decimals |
| [Kev repository](https://github.com/jaredpalmer/kev) | Local serving command and System One endpoint |

Branch URLs may change; blob IDs identify the source content inspected. Fixtures are constructed from these contracts, not claimed to be recorded outputs from paid or neural inference calls.

## Wire format comparison

| Property | Jev | Kev | Laya through bundled sidecar |
|---|---|---|---|
| Request | `{model,state,questions}` | Same | Same; the sidecar passes state/questions to `agent.system_one` |
| Endpoint | TypeSafe `/v1/systemone` | Local `/v1/systemone` | Adapter `/v1/systemone` |
| Auth | Bearer key required | None by upstream local default; optional proxy key | Optional `SYSTEM_ONE_API_KEY`, on both inference and models endpoints |
| Questions | `noul`, `choice`, `score` | Same | Same |
| Answer envelope | `{model,answers,usage}` | Same, optional latency metadata | Same, extra `action` metadata inside answers |
| Model discovery | `models[].name` | `models[].id` | `models[].id`; adapter identifier is configurable |
| Score limits | Documented 2–10 | Current source 1–255; bridge shared subset 2–255 | Bridge 2–255, further restricted by exact tokenizer budget |
| Instructions | Required in documented API | Optional in latest source; bridge requires explicit instructions | Explicit instructions required |
| Scalar top-level state | Not documented; rejected by Jev profile | Supported JSON | Rejected; use text, object or array |
| Probability precision | No fixed precision guaranteed in docs; examples use two decimals | Four decimals now; older versions used two | Four decimals |
| Score legend | Rendered string values | Rendered string values | Original criteria preserved, potentially objects/arrays |
| Model selection | Request model alias/id | Actual served checkpoint is server configuration | `--model` selects a public adapter ID; `--checkpoint` / `--subfolder` load the model |

Compatibility does not mean an identical supported superset. In particular, this bridge deliberately requires explicit question instructions and at least two score levels even when a backend accepts less. All built-in tools use that explicit subset.

## Changes implemented

1. All runtime settings are `SYSTEM_ONE_*`; canonical tools and host integrations use neutral names.
2. `/v1/models` accepts `id` or `name`, preserves metadata and rejects empty, conflicting or duplicate identities. A versioned answer model need not equal the requested alias.
3. Provider profiles validate known input restrictions. `jev` checks the documented ten-level maximum before making HTTP calls. `laya` caps requests at the sidecar's 64 questions; general multi-question tool batching respects it.
4. Laya's extra metadata is retained but does not authorize any action. A structured score legend is valid only when it equals the caller's original criterion. String legends remain accepted because rendering differs by provider.
5. Rounding validation imposes feasible unit probability mass and score means. Laya uses ±0.00005 rounding intervals. Generic, Jev and Kev use the conservative ±0.005 envelope so both current and older Kev endpoints remain usable; this is a declared validation tolerance, not a guarantee about Jev's serialization precision. Known-provider Choice/Score confidence must be present and finite. Generic missing confidence stays unknown and cannot auto-approve.
6. Transport supports explicit bearer keys or private Node-side key files, rejects redirects, keeps one deadline across queueing/retries, and recognizes Jev's 529 overload status. Retry-After is honored within that same deadline; retries default to zero and must be enabled deliberately.
7. The optional Laya sidecar preloads one real checkpoint, exposes models and inference, applies bounded HTTP/concurrency limits and optional bearer authentication, and rejects unknown model names. It does not download weights in tests.
8. Laya preflight checks state, every instruction and every option with the loaded tokenizer. It rejects all truncation, including upstream option shortening and question-head clipping. It does not silently enlarge a checkpoint window or split evidence across separate judgments.

## Verification evidence and limits

`tests/providers.test.mjs` exercises the fourteen tools against independent provider-shaped HTTP fixtures, mixed types, model discovery, bearer headers, malformed replies, limits, four-decimal precision, legacy rounding, secret-file safety, CLI doctor, MCP subprocesses and the optional Claude function path.

`tests/python/test_laya_adapter.py` tests adapter validation, tokenizer budgets, authentication, real loopback HTTP, duplicate JSON/header rejection, size limits, concurrency and error redaction. `tests/laya-e2e.test.mjs` connects the actual Python HTTP adapter to the actual Node client, CLI doctor and MCP subprocess using an explicit fake agent. The fake agent is confined to `tests/fixtures/`; the production adapter CLI never selects it.

Read `reports/validation.json` and `reports/adapter-validation.json` for actual run counts. Live Jev, Kev and Laya inference and authenticated host sessions were **not executed**: no models, API credentials or host sessions were available. Run `npm run test:live` separately for each configured backend. That acceptance suite intentionally fails, rather than silently skipping, when context budgets or semantic checks are unmet. Laya's short context may prevent long-context compaction/review acceptance even though its transport and short requests conform.

No equivalence of accuracy, calibration, confidence thresholds, hardware performance, information retention or prompt-injection resistance is asserted.

## Local Decider and Shisa extension (0.4.0)

See [LOCAL_MODELS.md](LOCAL_MODELS.md) for the additional source identifiers, exact payloads and serving commands. `decider` uses native System One with 2–255 Choice options, 2–10 Score levels, four-decimal probabilities/two-decimal scores, and `models[].name`. The bundled eager CUDA wrapper honors the 35B checkpoint's `use_graphs=False` requirement. `shisa` is a different transport: verified chat/tokenization scaffold → vLLM single-token completions → restricted A–Z logprobs, with forced-prompt recovery for missing letters. Its Score mean and maximum-probability confidence are bridge-defined; they are not claimed to reproduce Jev's confidence statistic.

The shared tools, ordinary automatic hooks and bundled Claude function hook use the same adapters. Additional Node/Python tests cover real HTTP/subprocesses and named synthetic neural/tokenizer fixtures. Actual Decider/Shisa weights, vLLM GPU serving and authenticated native host sessions were not available here. No live-inference or calibrated-quality parity is claimed.
