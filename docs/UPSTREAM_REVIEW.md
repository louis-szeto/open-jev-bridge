# Historical architecture audit plus current provider update

The original sections below describe the initial architecture. For current multi-provider behavior and newer source identifiers, [PROVIDER_COMPATIBILITY.md](PROVIDER_COMPATIBILITY.md) supersedes the earlier local-only assumptions.

# Upstream review and implementation decisions

Review date: 2026-09-22. The requested plugin-creator/subagent runner was not available in the build session. Sources were inspected directly through GitHub and official documentation. No independent subagent was executed; the optional shipped reviewer prompt is for subsequent host-assisted review. This repository was implemented independently rather than copied wholesale or silently redirected to a public provider.

## Sources inspected

| Source | Relevant findings | Selected fetched source identifier |
|---|---|---|
| [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) | Two-Noul tool/result retention, pinned pairs, verbatim prose, reduction fallback, automatic context threshold; function API `session.compact` and `turn.complete` | `hooks/fast-jev.ts` blob `cd894e2efcb70bbc3dc02d4e95897eab1c45cafa`; `hooks/hooks.json` blob `c99f2b5e882a84502889edac2634b0d211303223` |
| [jev-belay](https://github.com/valentynkit/jev-belay) | Stop check for unsupported completion, local execution evidence, four semantic questions, privacy bounds, fresh passing-check veto, finite blocks/cooldown/fail-open | `belay.mjs` blob `2dec6cfbeeefb364d916176680e2598abc4e0dde` |
| [jev-mcp](https://github.com/jkudish/jev-mcp) | Ten task-specific tools, strict schemas, partial invalid handling, distribution integrity, regex workers, patch/claim policy | Repository tree `7162ac4440522b6c19cf1a4f336e0ef7f0f24d8f`; `src/index.ts` blob `5a78bde8443a2b8253b0ae9e11fd6a70fa55e823`; `src/lib.ts` blob `394b1e5c60101a249829b42779b8d70375dbd1bb` |
| [Kev](https://github.com/jaredpalmer/kev) | `/v1/systemone`, `/v1/models`, typed answers, independent two-decimal rounding, finite state/branch limits, serving quick start and no default authentication | `kev/serve.py` blob `16f498ee5b04b4cedd8588970b1e7d7a8b12e8dc`; `kev/api.py` blob `3872906b18e01faed904aac848a795ac558e3f31`; LICENSE blob `e1ece45b775283628888a36bc75f56078cee9de0` |
| [Claude plugin-dev](https://github.com/anthropics/claude-code/tree/main/plugins/plugin-dev) | Plugin layout, hooks/MCP/skills/agents, validation and native acceptance workflow | `README.md` blob `7b7006352b471382a4894fa90a4bba625ab2569a` |

Blob IDs identify the selected file contents fetched, not a claim that entire repositories were cloned or tested. Default branches can change. Recheck these contracts when upgrading a host/model. The container could not download npm dependencies or clone upstream repositories; the implementation therefore uses Node built-ins and its own explicit contract fixtures. The upstream test suites were not executed.

Official host/protocol references: [Claude plugins](https://code.claude.com/docs/en/plugins), [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference), [Claude hooks](https://code.claude.com/docs/en/hooks), [Codex build plugins](https://learn.chatgpt.com/docs/build-plugins), [Codex hooks](https://learn.chatgpt.com/docs/hooks), [MCP stdio transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

## Capability matrix — do not hide host differences

| Capability | Claude stable command hooks | Claude optional function-hook variant | Codex documented command hooks |
|---|---|---|---|
| Local Kev MCP judgment tools | Yes | Yes | Yes |
| Evidence-sensitive Stop continuation | Yes | Yes | Yes, after native trust |
| Pure compaction library/MCP tool | Yes | Yes | Yes |
| Pre-compaction private checkpoint | Yes | Not needed for the function path | Yes |
| Post-compaction historical excerpt | SessionStart compact | Host returns replaced messages | SessionStart compact |
| Direct replacement of live history | **No** | **Implemented for supporting opt-in runtime; not natively exercised here** | **No documented replacement output** |
| Context-usage-driven compaction trigger | Host built-in trigger | `turn.complete` -> `$.session.compact()` | Host built-in trigger |
| Unattended native hook trust bypass | No | No | No |

The upstream function plugin targets a newer/early-access Claude runtime and advertises the `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1` flag (upstream references Claude 2.1.274+). The conventional hook docs alone do not prove that API exists on every Claude installation. This implementation isolates the optional module in a standalone variant; unsupported runtimes must use the stable variant. Do not install both variants or mix native plugin and direct integration for one host.

Codex documents hook discovery under `~/.codex/hooks.json` and plugin hook manifests, Stop continuation via `decision:block`, and SessionStart compact additional context. It does not document replacing history by returning a message array from PreCompact. Editing its rollout files is not a valid substitute. Consequently the Codex integration provides a useful checkpoint supplement without falsely promising direct context-window pruning or exact parity with the function-hook host.

## Intentional differences and conservative choices

The ten judgment purposes are covered, not every upstream SDK helper, configuration flag, transport or exact argument spelling. The bridge ships `system_one_*` names and optional `jev_*` aliases using bridge schemas. It omits automatic hosted fallback and TypeSafe SDK dependencies; explicit remote URLs and bearer credentials are supported. HTTP transport now accepts any explicitly configured System One endpoint, including hosted Jev and the bundled local Laya adapter. It rejects duplicate IDs and oversized evidence rather than silently sanitizing/truncating them into a potentially confident verdict. Independent classification/rerank work may use more requests to keep each bounded state complete.

Legacy rounding validation supports Kev's earlier two-decimal response construction; current Kev emits four decimals (see the current provider audit); a fixed total-probability tolerance appropriate for a small catalog is insufficient for 255 rounded options. Missing confidence is never manufactured. Patch review and claims remain advisory and cannot execute or certify tests.

Completion evidence is stricter than merely recognizing a runner string. A check must start after the latest observed edit and succeed; failures dominate success markers. `echo`, `printf` and `cat` output are not fresh test executions. Recognized custom scripts may supply a real runner summary. This remains a heuristic over supplied/host transcript data, not an adversarial execution-attestation system. Explicit blocked/partial outcomes do not trigger repeat completion enforcement.

Stable hooks use one finite model-operation budget, loop guards, private atomically written state and fail-open behavior. Native trust remains with the host. Standard Node HTTP security guarantees are not silently attributed to the isolated function runtime's host-owned HTTP implementation.

## Review findings addressed in this build

Tests cover prototype-like identifiers, invalid/missing answers, confidence nullability, large-catalog rounding, score/distribution contradictions, hidden verification failures, checks started before edits, quoted command/output false positives, orphan call/result pairs, atomic failure, duplicate hook installation, unrelated settings preservation, installation rollback, and MCP discovery errors that must not be mistaken for an absent registration. Additional security scope and unresolved platform limits are recorded in SECURITY.md and TESTING.md rather than papered over by mocks.
