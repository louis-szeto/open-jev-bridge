# Offline CI

## v0.5.0: stale standalone add-on tests

Run `36662426709` at commit
`fd59eae02eafbff37395fae16a3f1172a08fa50e` failed on Ubuntu/macOS with Node
22/24. The archived matrix results report 854 tests, 851 passes and the same
three failures: choice, noul and score HTTP tests in
`tests/openjev-addon.test.mjs` expected `openjev-llamacpp-addon`, while the
integrated adapter correctly returned `openjev-llamacpp`.

The retired standalone add-on suite survived a release ZIP overlay. Its 57
scenarios already exist in `tests/openjev-sidecar.test.mjs`, with the current
transport assertion and a shared fixture. Remove the duplicate from Git; retain
the canonical suite unchanged. No assertion weakening, skipped tests, runtime
changes or matrix reduction is needed. The resulting count is 804 Node tests
(854 minus 57 duplicate scenarios plus seven source-layout regressions), and
72 Python adapter tests.

`npm run check` now checks for that exact retired path before other checks. It
reports an actionable error without deleting anything, detects dangling symlinks
with `lstat`, and requires the canonical sidecar suite to remain present. Tests
cover clean layouts, overlay leftovers, symlinks, missing suites and the actual
repository layout.

For upgrades, prefer a Git update that applies tracked deletions. Extracting a
ZIP over a nonempty directory cannot delete retired files. If the source check
finds the old suite, review and remove only `tests/openjev-addon.test.mjs`;
keep `tests/openjev-sidecar.test.mjs`. Use `npm run test:openjev` instead of the
retired add-on-only test command.

Failure evidence: https://github.com/louis-szeto/open-jev-bridge/actions/runs/36662426709

## Historical v0.4.4 macOS investigation

### Observed evidence

The connected repository's run `36656176784`, commit
`b40a30417adef6008430571cb77e7a20f2ac5db8`, passed Ubuntu with Node 22 and 24.
The macOS/Node24 job (`109700908075`) used macOS 26.6.2, Node 24.20.0 and
setup-python CPython 3.12.10. Its log reports 699 tests, 690 passed, nine failed,
zero skipped/cancelled tests. The other macOS matrix leg was subsequently marked
cancelled. Source checks passed before the Node tests.

The old validation runner printed only the last 16,000 log characters, which in
this run started at successful test 603. It hid the nine failing test blocks from
the console. The full uploaded `tests.log` was not available in this build
session, so the precise remote failure messages have not been asserted here.

References:
- https://github.com/louis-szeto/open-jev-bridge/actions/runs/36656176784
- https://github.com/actions/setup-python/issues/1223
- https://github.com/python/cpython/blob/3.12/Lib/http/server.py

### Reproduced defects and fixes

**Loopback startup / reverse DNS.** Both real Python adapters share
`create_server` in `adapters/laya_server.py`. Python's `HTTPServer.server_bind`
performs a reverse-DNS `socket.getfqdn` call before listen; setup-python issue
1223 documents that call taking over 30 seconds on affected macOS runners.
These servers already restrict the bind address to numeric loopback and do not
need a hostname lookup. The custom server now uses `TCPServer.server_bind` and
sets numeric `server_name` and bound `server_port` without DNS.

A controlled baseline experiment replaced `socket.getfqdn` with a resolver error
and ran `laya-e2e.test.mjs` plus `local-models-e2e.test.mjs`. v0.4.4 produced nine
failures and three passes. The patched server produced twelve passes under the
same injected error. `tests/python/test_server_portability.py` permanently covers
DNS-free bind, real HTTP, localhost normalization, public-address rejection and
occupied-port errors. This removes the documented blocker without turning off
Python-backed integration tests on macOS. It is strong supporting evidence for
the failure mechanism, not a substitute for a fresh hosted matrix run.

**MCP teardown race.** The old harness waited for `exit` only when cleanup began.
If the process had already exited, cleanup waited forever. Reproduced by killing
an initialized MCP child, awaiting its exit and then calling cleanup. The harness
now subscribes at spawn, caches the close promise, rejects pending calls and
supports repeated cleanup. Regression tests exercise early exit and outstanding
requests.

**Timing assumptions and diagnostic loss.** Protocol tests now wait for the
relevant message/request rather than assuming a 30ms sleep is sufficient.
Retry-After's deadline test uses a controlled HTTP response, independently of
whether a TCP connection can start inside 40ms. Timeout/cancellation behavior is
still tested with actual HTTP elsewhere. CI reports first failure blocks as well
as retaining full logs, clears stale reports before running, and does not cancel
other matrix jobs on the first failure.

**Packaging and backend forwarding.** The source check compares the shipped
function-hook sources/manifests/licenses against the main tree without rebuilding
and hiding stale files. Benchmark subprocesses receive `SYSTEM_ONE_SHISA_BACKEND`
and all OpenJev tuning settings; they no longer accidentally test vLLM while the
parent was configured for Shisa/llama.cpp.

## Run the same gate

```bash
npm run validate
```

No npm dependencies or lockfile are required. The six stages are source/schema/
plugin integrity, all Node tests, all Python adapter tests, the coverage run,
general benchmarks and provider benchmarks. Model fixtures are explicit. A
nonzero exit, skipped/cancelled Node test, empty test count or unsuccessful Python
suite makes the gate fail. Local reports live in `reports/` and are not shipped
inside the clean source ZIP.

The workflow retains `ubuntu-latest` and `macos-latest`, each with Node 22 and 24
and Python 3.12. Matrix `fail-fast` is false. File-level test timeouts default to
120 seconds and each validation subprocess is bounded to 600 seconds; these are
CI runner limits, **not** model/client/hook deadlines. They can be configured by
`BRIDGE_CI_TEST_TIMEOUT_MS` and `BRIDGE_CI_STAGE_TIMEOUT_MS` with validated bounds.
The whole job has a 30-minute limit. Logs are uploaded on success or failure and
GitHub's step summary lists the actual stage outcomes.

## Verification boundary

Offline tests use explicit HTTP/model/tokenizer fixtures and host CLI doubles.
A local green result is not evidence that every hosted OS/Node combination has
passed. Check the pull request's **Offline contracts and integration** jobs for
the commit being reviewed; uploaded `validation.json` files record the platform,
runtime versions, stage exit codes and test counts. The supported matrix remains
Ubuntu/macOS with Node 22/24 and Python 3.12.

Actual model weights, CUDA inference, and native authenticated Claude/Codex
sessions require `test:live`, live benchmarks and local host acceptance checks.
Passing offline CI must not be described as successful live-model or
authenticated-host testing.
