"""Explicit fake neural backend for REAL Decider HTTP-wrapper tests. Never production-imported."""
from pathlib import Path
import json
import os
import sys
import types
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def render_state(state):
    return state if isinstance(state, str) else json.dumps(state, ensure_ascii=False)


def fixture_modules():
    package = types.ModuleType("decider")
    module = types.ModuleType("decider.systemone")
    module.render_state = render_state
    return {"decider": package, "decider.systemone": module}


class FakeAgent:
    layout = "plain"
    eng = None
    def __init__(self):
        self.calls = []
        self.preflights = []
        self.m = types.SimpleNamespace(tok=types.SimpleNamespace(encode=lambda text, **kw: list(text.encode("utf-8"))))
        self.row_override = None

    def _system_one_items(self, state, questions, **kwargs):
        self.preflights.append(kwargs)
        rows = self.row_override if self.row_override is not None else [{"ids": list(("Context:\n" + render_state(state) + json.dumps(q)).encode())} for q in questions.values()]
        return {}, [], rows

    def system_one(self, state, questions, **kwargs):
        self.calls.append({"state": state, "questions": questions, **kwargs})
        answers = {}
        for qid, q in questions.items():
            if q["type"] == "noul":
                answers[qid] = {"type": "noul", "noul": .01 if qid.endswith(("_call", "_result")) or qid == "injection" else .9999}
                continue
            keys = list(q["criteria"]) if q["type"] == "choice" else list(map(str, range(len(q["criteria"]))))
            best = 0 if q["type"] == "choice" or qid in ("test_gap", "blast_radius") else len(keys)-1
            a = {"type": q["type"], "confidence": 1.0, "certainty": 1.0,
                 "probabilities": {k: float(i == best) for i, k in enumerate(keys)}}
            if q["type"] == "choice":
                a["choice"] = keys[best]
            else:
                a.update(score=float(best), legend={str(i): x if isinstance(x, str) else json.dumps(x) for i, x in enumerate(q["criteria"])},
                         level_fit={str(i): float(i == best) for i in range(len(keys))}, fit_mass=1.0)
            answers[qid] = a
        return {"model": "decider-v1", "answers": answers, "usage": {"input_tokens": 40, "output_tokens": 0}}


if __name__ == "__main__":
    sys.modules.update(fixture_modules())
    from adapters.decider_server import Runtime
    from adapters.laya_server import create_server
    server = create_server(Runtime(FakeAgent(), api_key=os.environ.get("SYSTEM_ONE_API_KEY")), port=0)
    print(json.dumps({"fixture": True, "url": f"http://127.0.0.1:{server.server_port}"}), flush=True)
    server.serve_forever()
