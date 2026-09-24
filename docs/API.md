# API, policies and integration contract

## System One, not chat completions

The transport calls `POST {base}/v1/systemone`. Base forms `/`, `/v1`, `/v1/systemone` and path-prefixed proxies are normalized without doubling path segments. `GET {base}/v1/models` expects a `models` array, not OpenAI's `data` array. The bridge's default is `http://127.0.0.1:8009`; no TypeSafe API key is required.

```json
{
  "model": "kev-latest",
  "state": {"label": "blue", "level": "high"},
  "questions": {
    "is_blue": {"type": "noul", "instructions": "Is the label blue?"},
    "label": {
      "type": "choice",
      "instructions": "Which label is selected?",
      "criteria": {"blue": null, "red": null}
    },
    "level": {
      "type": "score",
      "instructions": "Which level is selected?",
      "criteria": ["low", "medium", "high"]
    }
  }
}
```

State, instructions and criterion descriptions may be arbitrary JSON. Noul criteria, when supplied, use `true`/`false` keys. Choice requires 1–255 options; Score requires 2–255 ordered levels. `system_one` is the family/SDK response naming, not a `response_format` field: no such field is sent. Responses contain `model`, typed `answers`, and upstream metadata such as `usage` and `latency_ms`.

```json
{
  "model": "kev-latest",
  "answers": {
    "is_blue": {"type": "noul", "noul": 0.98},
    "label": {
      "type": "choice", "choice": "blue", "confidence": 0.96,
      "probabilities": {"blue": 0.98, "red": 0.02}
    },
    "level": {
      "type": "score", "score": 1.95, "confidence": 0.98,
      "legend": {"0": "low", "1": "medium", "2": "high"},
      "probabilities": {"0": 0.00, "1": 0.05, "2": 0.95}
    }
  },
  "usage": {"input_tokens": 40, "output_tokens": 70},
  "latency_ms": 30
}
```

This is an illustrative contract example, not measured inference output. Score is an expected zero-based level index, not a confidence. Backend confidence is distinct from selected-option probability. Missing confidence stays null and cannot yield automatic approval. Every distribution must have exactly the requested keys; a selected choice must be a maximal reported probability; scores must fit the scale and their distribution's feasible expected-value interval; score legends require matching keys; string values are accepted, and a structured value must match the original criterion.

Provider profiles and source differences are documented in [PROVIDER_COMPATIBILITY.md](PROVIDER_COMPATIBILITY.md). Jev model lists use `name`, whereas Kev and the bundled Laya adapter use `id`; the client normalizes both. The `jev` profile enforces the documented 2–10 Score limit and documented input content types. The `laya` profile uses four-decimal rounding validation and a 64-question sidecar limit. Generic/Kev/Jev retain a conservative two-decimal tolerance for older compatible endpoints; modern Kev emits four decimals. Validation checks whether a normalized underlying distribution can exist within the rounding intervals and whether the score fits its achievable mean. It does not certify statistical calibration.

The raw tool remains explicit: instructions are required and Scores need 2–255 levels (Jev: 2–10), even where a newer backend accepts a more permissive input. Named provider profiles reject missing Choice/Score confidence; generic preserves it as unknown.

## Tool catalog

All fixed input objects are strict: misspelled and unknown fields raise an error. `context` in patch review is deliberately an open JSON object. IDs are preserved in results; duplicate caller IDs are rejected. Internal model-choice keys are generated independently to avoid reserved-ID/prototype collisions. Optional `jev_*` aliases cover the ten judgment tools, but use **these bridge schemas**; this is purpose/behavior coverage rather than byte-for-byte compatibility with every upstream release.

| Tool | Required arguments | Important optional arguments | Output behavior |
|---|---|---|---|
| `system_one_verify` | `claims`, `evidence` | `auto_accept` | Per-claim verified/contradicted/unsupported verdict, probabilities, confidence, optional evidence source; partial invalid answers isolated |
| `system_one_screen` | `text` | `purpose`, `block_at`, `review_at` | Injection/substance/relevance signals and advisory pass/review/block/skip |
| `system_one_find` | `query`, `candidates[{id?,text}]` | `top_k` | Existence answered/partial/absent plus a Choice-ranked candidate list |
| `system_one_classify` | `items[{id?,text}]`, `classes[{id,description}]` | `purpose`, `auto_accept`, `minimum_margin` | Independent class decisions; high selected probability and sufficient margin required for auto |
| `system_one_decide` | `decision`, `evidence`, `candidates[{id,description}]` | `priorities[]`, `requirements[]`, `escape_hatches`, `auto_accept` | Candidate/ask_user/investigate/none recommendation, independent requirement checks, conflicts |
| `system_one_rerank` | `query`, `candidates[{id?,text}]` | `top_k` | Independent relevance scores, stable descending rank; no missing-answer-to-zero coercion |
| `system_one_compare` | `passage_a`, `passage_b` | `aspects[]`, `auto_accept` | same_fact/contradicts/different_facts overall and per aspect |
| `system_one_extract` | `document`, `fields[{id,pattern,description,flags?}]` | `auto_accept`, `minimum_margin` | Verbatim selected regex match, UTF-16 offsets, or explicit uncertainty/not_found |
| `system_one_review` | `request`, `diff` | `tests`, `context`, `auto_accept`, `review_at`, `composite_floor` | Four 0–2 rubrics, safe-to-apply signal, weighted composite, auto/review/escalate |
| `system_one_gate` | `request`, `diff`, `claims`, `evidence` | Review options | Review and claim verification in one HTTP request; worst action wins |
| `system_one_query` | `state`, `questions` | `model` | Strict typed raw answer validation; never sends a chat-completions request |
| `system_one_compact` | `messages` | `goal`, `options` | New canonical messages, decisions and statistics; never modifies a file |
| `system_one_belay` | `messages` | `final_message` | Advisory completion block with observed evidence counts |
| `system_one_status` | none | none | Live model inventory, bridge capabilities and process metrics |

Evidence accepts a string, `{id?,text}`, or an array of up to 16 such items. Empty evidence is allowed as explicit missing information but cannot approve a claim. Source attribution is a model judgment, not a verified citation parser.

Review composite = `0.4*correctness/2 + 0.3*spec_match/2 + 0.15*(1-test_gap/2) + 0.15*(1-blast_radius/2)`. Default thresholds are auto 0.8, review 0.5 and composite floor 0.7. Auto requires sufficient confidence, safety and composite **and** supplied test evidence. Missing/invalid scores escalate. Gate cannot automatically accept unsupported claims; a confident contradiction escalates. `verify.action=auto` means confidence in the returned verdict, which may itself be `unsupported` or `contradicted`; it never converts those verdicts into supported claims.

Screen defaults are block 0.75/review 0.25; substance/relevance below 0.3 can skip only after injection checks. Find existence thresholds are answered ≥0.7, absent <0.35, otherwise partial. Classify/extract defaults use selected probability ≥0.85 and margin ≥0.5; null confidence still requires review. Ties preserve input order. Decision candidate IDs cannot equal an active escape-hatch label.

## Context, batching and bounded extraction

The upstream server has finite per-state/per-branch token limits. This bridge intentionally does **not** assume Jev's larger context budget. The default 6,000 state / 7,600 request budget uses UTF-8 byte counts as a conservative tokenizer-free estimate. These values are intentionally not claimed to equal exact tokenizer counts. General judgment tools reject oversized context rather than silently deleting evidence and then approving the result. Increase budgets only after checking the actual local model/server limits.

Questions over a shared complete state can be split into bounded sequential requests. Classification and reranking use independent per-item states, so large candidate sets do not silently lose competitors or item text. This prioritizes correctness/context isolation over minimum request count. `system_one_gate` and `system_one_review` require their combined questions to fit a single request. Compaction batches question pairs and uses at most its configured concurrency.

Find/classify/rerank item text is limited to 2,000 characters; oversized excerpts are rejected. Rerank aggregate candidate text is capped at 100,000 characters. Classification is bounded to 64 items, 250 classes and 8,000 item–class combinations. Decide allows 2–6 candidates and at most three requirements. Other limits are machine-readable in `src/tool-schemas.mjs` and returned by `tools/list`.

Each extraction field uses a separate bounded worker. Allowed flags are `i`, `m`, `s`, `u`, each once; matching is global internally. Candidates are full matches, not capture-group output. At most 20 unique matches of at most 2,000 characters are retained per field. Oversize matches, excess matches or candidate truncation force review. Workers have a 1,000 ms deadline, memory limits and cancellation. Selected values are exact slices of the original document. Matching no candidates is a deterministic regex fact, not proof that the desired semantic field is absent under every possible pattern.

## Canonical messages and compaction

```json
{
  "messages": [
    {"role":"user","text":"Inspect the parser","toolUses":[]},
    {"role":"assistant","text":"Reading it","toolUses":[
      {"tool_use_id":"read-1","tool":"Read","input":{"file_path":"parser.js"}}
    ]},
    {"role":"user","text":"","toolUses":[],"toolResults":[
      {"tool_use_id":"read-1","text":"...file contents...","isError":false}
    ]},
    {"role":"assistant","text":"Continuing the implementation","toolUses":[]}
  ],
  "options":{"preserveRecentMessages":2,"keepThreshold":0.5}
}
```

Pending tool calls, pairs touching the first/recent/protected message, and opaque content are pinned. Two Nouls score retaining the call and retaining its result; a retained result always retains its call. A low result/high call truncates only the result, never expands a short result. Two low scores remove the pair. User and assistant text and ordering are preserved. Orphan, duplicate and reversed pairs cause refusal. All model answers are checked before any new transcript is returned. Inputs are not mutated. Unchanged host objects keep identity/handles; rebuilt messages omit handles so the host uses edited content.

Decision state omits full result bodies and progressively shortens older visible text/tool inputs only for classification; the returned transcript's prose stays verbatim. If even protected current context cannot fit, the operation refuses. Canonical checkpoints do not serialize images, private thinking or arbitrary host-internal blocks; the original host transcript remains untouched. Character reduction is reported separately from exact model-token savings.

## MCP transport

The server implements stdio newline-delimited JSON-RPC 2.0, initialization/version negotiation, initialized notifications, ping, tools/list, tools/call and cancellation. Supported protocol versions are 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05; unsupported versions negotiate the newest supported version for the client to accept or reject. It does not advertise resources, prompts, sampling, HTTP MCP transport or batch RPC. Stdout contains protocol messages only. Tool errors use `isError:true`; malformed RPC uses JSON-RPC error codes. Up to 16 tool calls can be pending; individual inbound frames are bounded to 4 MB. The Node HTTP layer adds independent concurrency/queue/body limits and deadlines.

This is an independent protocol implementation, not a claim of official MCP SDK certification. A real subprocess test client exercises the on-wire lifecycle, every tool, cancellation, malformed input, Unicode chunking and process behavior. Native-host acceptance still needs the actual host versions.

## Provider-native translations

The MCP input/output interface is unchanged for `decider` and `shisa`. Decider uses `/v1/systemone`; `/decide` is not accepted as a substitute. Shisa uses `/tokenize`, `/v1/completions` and OpenAI-shaped `/v1/models`, not `/v1/systemone`. Its raw-query result includes a `bridge` diagnostic object recording HTTP/readout/fallback request counts and explicit score/confidence/temperature policies. Those diagnostics do not authorize actions. Endpoint suffixes `/v1`, `/v1/systemone`, `/v1/completions` are normalized while preserving a reverse-proxy prefix.

Exact request/response contracts, malformed-response handling and option limits: [LOCAL_MODELS.md](LOCAL_MODELS.md).
