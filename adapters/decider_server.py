"""Local eager System One server for Mapika/decider-35b-a3b.

The checkpoint card requires use_graphs=False for the 35B MoE. This wrapper uses
Decider.system_one, not the upstream dense-model CUDA-graph HTTP engine. It shares
only bounded HTTP plumbing with the Laya adapter; no Laya dependency is loaded.
Run: python3 -m adapters.decider_server --checkpoint /models/decider-35b-a3b
Contract/source pins: docs/LOCAL_MODELS.md. No silent fixture/CPU fallback.
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Any
from .laya_server import ContractError, Runtime as HttpRuntime, create_server, validate_request


def load_agent(checkpoint: str, device: str = "cuda") -> Any:
    import torch
    from decider.infer import Decider
    if not re.fullmatch(r"cuda(?::[0-9]+)?", device) or not torch.cuda.is_available():
        raise RuntimeError("This 35B serving path requires available CUDA; no implicit CPU fallback")
    index = int(device.split(":", 1)[1]) if ":" in device else 0
    if index < 0 or index >= torch.cuda.device_count():
        raise RuntimeError("Requested CUDA device is not available")
    with torch.cuda.device(index):
        if not torch.cuda.is_bf16_supported(including_emulation=False):
            raise RuntimeError("This bf16 35B serving path requires BF16 support; select a compatible GPU/runtime")
    return Decider(checkpoint, device=device, dtype=torch.bfloat16, use_graphs=False)


class Runtime(HttpRuntime):
    def __init__(self, agent: Any, model: str = "decider-35b-a3b", api_key: str | None = None,
                 max_state_tokens: int = 32768, max_row_tokens: int = 36864,
                 max_request_tokens: int = 131072, max_rows: int = 1024,
                 max_fwd_tokens: int = 8192):
        super().__init__(agent, model, api_key)
        self.limits = dict(max_state_tokens=max_state_tokens, max_row_tokens=max_row_tokens,
                           max_request_tokens=max_request_tokens, max_rows=max_rows,
                           max_fwd_tokens=max_fwd_tokens)
        if any(not isinstance(v, int) or isinstance(v, bool) or v < 1 for v in self.limits.values()):
            raise ValueError("All inference limits must be positive integers")
        if getattr(agent, "eng", None) is not None:
            raise ValueError("Decider 35B must be loaded with use_graphs=False")
        if getattr(agent, "layout", "plain") != "plain":
            raise ValueError("This adapter is for the published plain-layout 35B checkpoint")
        if not callable(getattr(agent, "_system_one_items", None)):
            raise ValueError("Decider lacks required preflight API; install the documented source revision")

    def models(self) -> dict:
        return {"models": [{"name": self.model, "backend": "decider-python-eager",
                             "max_questions": 512, "max_choice_options": 255,
                             "max_score_levels": 10, "truncation_policy": "reject",
                             "limits": self.limits}]}

    def evaluate(self, request: Any) -> tuple[int, dict]:
        validate_request(request, self.model, max_questions=512)
        for q in request["questions"].values():
            if q["instructions"] == "":
                raise ContractError("Instructions must not be empty")
            if q["type"] == "choice" and len(q["criteria"]) < 2:
                raise ContractError("Decider requires 2..255 choice options")
            if q["type"] == "score" and len(q["criteria"]) > 10:
                raise ContractError("Decider supports 2..10 score levels")
        if not self.lock.acquire(blocking=False):
            return 429, {"error": "model_busy"}
        try:
            from decider.systemone import render_state
            state, questions = request["state"], request["questions"]
            # Exact inspected plain/state_first prefix, including Decider's array indexing.
            n = len(self.agent.m.tok.encode("Context:\n" + render_state(state), add_special_tokens=False))
            if n > self.limits["max_state_tokens"]:
                raise ContractError("Decider would truncate state; supply smaller complete evidence")
            kwargs = dict(independent=True, max_state_tokens=self.limits["max_state_tokens"], layout="state_first")
            # This pinned preflight helper tokenizes ALL instructions/options before GPU admission.
            _, _, rows = self.agent._system_one_items(state, questions, **kwargs)
            lengths = [len(row["ids"]) for row in rows]
            if (not lengths or len(lengths) > self.limits["max_rows"]
                    or max(lengths) > self.limits["max_row_tokens"]
                    or sum(lengths) > self.limits["max_request_tokens"]):
                raise ContractError("Decider expanded request exceeds configured row/token limits")
            result = self.agent.system_one(state, questions, max_fwd_tokens=self.limits["max_fwd_tokens"], **kwargs)
            if not isinstance(result, dict) or not isinstance(result.get("answers"), dict):
                raise RuntimeError("Invalid Decider answer envelope")
            return 200, {**result, "model": self.model}
        finally:
            self.lock.release()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8011)
    parser.add_argument("--checkpoint", default="Mapika/decider-35b-a3b")
    parser.add_argument("--model", default="decider-35b-a3b")
    parser.add_argument("--device", default="cuda")
    for name, default in [("state", 32768), ("row", 36864), ("request", 131072), ("fwd", 8192)]:
        parser.add_argument(f"--max-{name}-tokens", type=int, default=default)
    parser.add_argument("--max-rows", type=int, default=1024)
    args = parser.parse_args()
    agent = load_agent(args.checkpoint, args.device)
    runtime = Runtime(agent, args.model, os.environ.get("SYSTEM_ONE_API_KEY"), **{
        key: value for key, value in vars(args).items() if key.startswith("max_")})
    server = create_server(runtime, args.host, args.port)
    print(f"Decider eager adapter listening on {args.host}:{server.server_port}; truncation=reject", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
