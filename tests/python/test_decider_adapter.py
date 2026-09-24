import copy
import importlib.util
import json
from pathlib import Path
import threading
import types
import unittest
from unittest.mock import patch, Mock
from contextlib import nullcontext
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from adapters.decider_server import Runtime, load_agent
from adapters.laya_server import ContractError, create_server

spec = importlib.util.spec_from_file_location("decider_fixture", Path(__file__).parents[1] / "fixtures/decider_adapter.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


def request():
    return {"model": "decider-35b-a3b", "state": "blue", "questions": {
        "n": {"type": "noul", "instructions": "Is blue present?"},
        "c": {"type": "choice", "instructions": "Color?", "criteria": {"blue": None, "red": "Red"}},
        "s": {"type": "score", "instructions": "Rate", "criteria": ["low", "high"]}}}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.modules = patch.dict("sys.modules", fixture.fixture_modules())
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.agent = fixture.FakeAgent()

    def test_mixed_shapes_model_and_metadata(self):
        code, r = Runtime(self.agent).evaluate(request())
        self.assertEqual(code, 200)
        self.assertEqual(r["model"], "decider-35b-a3b")
        self.assertEqual(r["usage"]["output_tokens"], 0)
        self.assertIn("fit_mass", r["answers"]["s"])

    def test_inference_independent_eager_state_first(self):
        Runtime(self.agent).evaluate(request())
        self.assertTrue(self.agent.calls[0]["independent"])
        self.assertEqual(self.agent.calls[0]["layout"], "state_first")
        self.assertEqual(self.agent.calls[0]["max_fwd_tokens"], 8192)

    def test_long_state_rejected_before_model(self):
        with self.assertRaisesRegex(ContractError, "truncate"):
            Runtime(self.agent, max_state_tokens=4).evaluate(request())
        self.assertEqual(self.agent.calls, [])

    def test_state_boundary_includes_context_prefix(self):
        limit = len("Context:\nblue".encode())
        Runtime(self.agent, max_state_tokens=limit).evaluate(request())
        with self.assertRaises(ContractError):
            Runtime(self.agent, max_state_tokens=limit-1).evaluate(request())

    def test_rows_limit(self):
        with self.assertRaises(ContractError):
            Runtime(self.agent, max_rows=2).evaluate(request())
        self.assertEqual(self.agent.calls, [])

    def test_row_token_limit(self):
        self.agent.row_override = [{"ids": list(range(30))}]
        with self.assertRaises(ContractError):
            Runtime(self.agent, max_row_tokens=29).evaluate(request())

    def test_expanded_total_limit(self):
        self.agent.row_override = [{"ids": list(range(30))}] * 4
        with self.assertRaises(ContractError):
            Runtime(self.agent, max_request_tokens=100).evaluate(request())

    def test_empty_expansion_rejected(self):
        self.agent.row_override = []
        with self.assertRaises(ContractError):
            Runtime(self.agent).evaluate(request())

    def test_named_models(self):
        m = Runtime(self.agent).models()["models"][0]
        self.assertEqual(m["name"], "decider-35b-a3b")
        self.assertEqual(m["truncation_policy"], "reject")

    def test_forbid_dense_graph_engine(self):
        self.agent.eng = object()
        with self.assertRaisesRegex(ValueError, "use_graphs=False"):
            Runtime(self.agent)

    def test_forbid_other_layout(self):
        self.agent.layout = "chat"
        with self.assertRaisesRegex(ValueError, "plain-layout"):
            Runtime(self.agent)

    def test_missing_preflight_fails_explicitly(self):
        self.agent._system_one_items = None
        with self.assertRaisesRegex(ValueError, "preflight"):
            Runtime(self.agent)

    def test_invalid_limits(self):
        for n in [0, -1, True, 1.5]:
            with self.subTest(n=n), self.assertRaises(ValueError):
                Runtime(self.agent, max_rows=n)

    def test_wrong_model(self):
        r = request(); r["model"] = "other"
        with self.assertRaises(ContractError):
            Runtime(self.agent).evaluate(r)

    def test_option_boundaries(self):
        for q in [{"type": "choice", "instructions": "q", "criteria": {"one": None}},
                  {"type": "score", "instructions": "q", "criteria": ["x"]*11},
                  {"type": "noul", "instructions": ""}]:
            with self.subTest(q=q), self.assertRaises(ContractError):
                Runtime(self.agent).evaluate({**request(), "questions": {"q": q}})

    def test_boundary_255_choice_10_score(self):
        r=request(); r["questions"]["c"]["criteria"]={str(i): None for i in range(255)}
        r["questions"]["s"]["criteria"] = ["level"]*10
        self.assertEqual(Runtime(self.agent).evaluate(r)[0], 200)

    def test_many_questions_are_bounded(self):
        r=request(); r["questions"]={str(i): request()["questions"]["n"] for i in range(513)}
        with self.assertRaises(ContractError):
            Runtime(self.agent).evaluate(r)

    def test_busy_no_inference(self):
        rt=Runtime(self.agent); rt.lock.acquire()
        try:
            self.assertEqual(rt.evaluate(request())[0], 429)
            self.assertEqual(self.agent.calls, [])
        finally:
            rt.lock.release()

    def test_model_exception_releases_lock(self):
        self.agent.system_one = Mock(side_effect=RuntimeError("private diagnostic"))
        rt=Runtime(self.agent)
        with self.assertRaises(RuntimeError):
            rt.evaluate(request())
        self.assertFalse(rt.lock.locked())

    def test_invalid_envelope(self):
        self.agent.system_one=lambda *a, **k: None
        with self.assertRaises(RuntimeError):
            Runtime(self.agent).evaluate(request())


class LoaderTests(unittest.TestCase):
    def setup_modules(self):
        cuda=types.SimpleNamespace(is_available=lambda: True, device_count=lambda: 2,
                                  is_bf16_supported=lambda **kw: True, device=lambda i: nullcontext())
        torch=types.SimpleNamespace(cuda=cuda, bfloat16="bf16")
        decider=types.ModuleType("decider.infer"); decider.Decider=Mock(return_value="agent")
        return {"torch": torch, "decider": types.ModuleType("decider"), "decider.infer": decider}

    def test_eager_loader_local_path_and_cuda(self):
        m=self.setup_modules()
        with patch.dict("sys.modules", m):
            self.assertEqual(load_agent("/models/custom path", "cuda:1"), "agent")
        m["decider.infer"].Decider.assert_called_once_with("/models/custom path", device="cuda:1", dtype="bf16", use_graphs=False)

    def test_no_cuda_no_fallback(self):
        m=self.setup_modules(); m["torch"].cuda.is_available=lambda: False
        with patch.dict("sys.modules", m), self.assertRaisesRegex(RuntimeError, "no implicit CPU"):
            load_agent("model")
        m["decider.infer"].Decider.assert_not_called()

    def test_no_bf16(self):
        m=self.setup_modules(); m["torch"].cuda.is_bf16_supported=lambda **kw: False
        with patch.dict("sys.modules", m), self.assertRaisesRegex(RuntimeError, "BF16"):
            load_agent("model")

    def test_missing_gpu_index(self):
        with patch.dict("sys.modules", self.setup_modules()), self.assertRaises(RuntimeError):
            load_agent("model", "cuda:7")


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.modules = patch.dict("sys.modules", fixture.fixture_modules()); self.modules.start(); self.addCleanup(self.modules.stop)
        self.agent=fixture.FakeAgent();self.rt=Runtime(self.agent, api_key="fixture-key")
        self.server=create_server(self.rt, port=0)
        self.thread=threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01},daemon=True);self.thread.start()
        self.url=f"http://127.0.0.1:{self.server.server_port}"
    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)
    def send(self, body=None, path="/v1/systemone", key="fixture-key"):
        data=body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        req=Request(self.url+path,data=data,headers={"Content-Type":"application/json","Authorization":f"Bearer {key}"})
        try:
            with urlopen(req, timeout=3) as r: return r.status,json.loads(r.read())
        except HTTPError as e:
            return e.code,json.loads(e.read())
    def test_mixed_real_http(self):
        self.assertEqual(self.send(request())[0],200)
    def test_models_name_shape(self):
        self.assertEqual(self.send(path="/v1/models")[1]["models"][0]["name"],"decider-35b-a3b")
    def test_auth_failure_no_inference(self):
        self.assertEqual(self.send(request(),key="wrong")[0],401);self.assertEqual(self.agent.calls,[])
    def test_unknown_route_not_native_decide(self):
        self.assertEqual(self.send(request(),path="/decide")[0],404)
    def test_oversized_state_no_truncation(self):
        self.assertEqual(self.send({**request(),"state":"x"*32769})[0],422);self.assertEqual(self.agent.calls,[])
    def test_busy_retry_status(self):
        self.rt.lock.acquire()
        try: self.assertEqual(self.send(request())[0],429)
        finally: self.rt.lock.release()
    def test_duplicate_json_rejected(self):
        self.assertEqual(self.send(b'{"model":"a","model":"b"}')[0],422)
    def test_runtime_error_redacts_output(self):
        self.agent.system_one=Mock(side_effect=RuntimeError("SECRET diagnostic"))
        code,r=self.send(request());self.assertEqual(code,502);self.assertNotIn("SECRET",json.dumps(r))
