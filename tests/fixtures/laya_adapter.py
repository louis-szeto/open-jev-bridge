"""Explicit test double injected into the real adapter. Never imported by production CLI."""
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from adapters.laya_server import Runtime, create_server


class Tokenizer:
    mask_token = "[MASK]"
    cls_token_id = 1
    sep_token_id = 2
    mask_token_id = 3

    def __call__(self, text, add_special_tokens=False):
        return {"input_ids": [10] * len(re.findall(r"\w+|[^\w\s]", text))}


class FakeAgent:
    def __init__(self, max_len=512, head_max_len=192):
        self.tok = Tokenizer()
        self.cfg = {"max_len": max_len, "head_max_len": head_max_len}
        self.calls = []

    def system_one(self, state, questions):
        self.calls.append((state, questions))
        answers = {}
        for key, question in questions.items():
            kind = question["type"]
            extra = {"action": {"act_probability": 0.9123}}
            if kind == "noul":
                answers[key] = {"type": kind, "noul": 0.9876, "confidence": 0.9876, **extra}
                continue
            options = list(question["criteria"]) if kind == "choice" else [str(i) for i in range(len(question["criteria"]))]
            selected = options[0]
            p = {option: float(option == selected) for option in options}
            if kind == "choice":
                answers[key] = {"type": kind, "choice": selected, "confidence": 1.0, "probabilities": p, **extra}
            else:
                answers[key] = {"type": kind, "score": 0.0, "confidence": 1.0, "probabilities": p,
                                "legend": {str(i): value for i, value in enumerate(question["criteria"])}, **extra}
        return {"model": "laya-rl-agent", "answers": answers,
                "usage": {"input_tokens": 20, "output_tokens": 0}}


if __name__ == "__main__":
    runtime = Runtime(FakeAgent(), "laya", os.environ.get("SYSTEM_ONE_API_KEY"))
    server = create_server(runtime, port=0)
    print(json.dumps({"url": f"http://127.0.0.1:{server.server_port}", "fixture": True}), flush=True)
    server.serve_forever()
