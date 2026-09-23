import copy
import importlib.util
import json
import os
from pathlib import Path
import socket
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from adapters.laya_server import Runtime, ContractError, check_input_budget, create_server, validate_request, MAX_BODY_BYTES

spec = importlib.util.spec_from_file_location("fixture", Path(__file__).parents[1] / "fixtures/laya_adapter.py")
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
FakeAgent = fixture.FakeAgent


def request_body():
    return {"model": "laya", "state": "blue label", "questions": {
        "yes": {"type": "noul", "instructions": "Is it blue?"},
        "color": {"type": "choice", "instructions": "Which color?", "criteria": {"blue": None, "red": "red"}},
        "count": {"type": "score", "instructions": "Rate quantity", "criteria": ["none", "one", "two"]}}}


class BudgetTests(unittest.TestCase):
    def test_small_complete_request(self):
        r = request_body()
        check_input_budget(FakeAgent(), r["state"], r["questions"])

    def test_structured_state_and_criteria(self):
        r = request_body()
        r["questions"]["count"]["criteria"] = [{"label": "low"}, ["high"]]
        r["questions"]["yes"]["instructions"] = {"question": "blue?"}
        check_input_budget(FakeAgent(), {"color": "蓝色"}, r["questions"])

    def test_reject_long_state_before_inference(self):
        agent = FakeAgent()
        r = request_body()
        r["state"] = "word " * 600
        with self.assertRaisesRegex(ContractError, "state"):
            Runtime(agent).evaluate(r)
        self.assertEqual(agent.calls, [])

    def test_reject_long_instructions(self):
        r = request_body()
        r["questions"]["yes"]["instructions"] = "word " * 300
        with self.assertRaisesRegex(ContractError, "head"):
            check_input_budget(FakeAgent(), r["state"], r["questions"])

    def test_reject_long_individual_option(self):
        r = request_body()
        r["questions"]["color"]["criteria"]["red"] = "word " * 50
        with self.assertRaisesRegex(ContractError, "option beyond"):
            check_input_budget(FakeAgent(), r["state"], r["questions"])

    def test_reject_many_options_that_trigger_upstream_shortening(self):
        r = request_body()
        r["questions"]["color"]["criteria"] = {f"option{i}": "description words" for i in range(100)}
        with self.assertRaisesRegex(ContractError, "head"):
            check_input_budget(FakeAgent(), r["state"], r["questions"])

    def test_sequence_boundary_includes_special_tokens(self):
        q = {"q": {"type": "choice", "instructions": "q", "criteria": {"a": None}}}
        # Tokens: 4 instruction, 2 option including MASK, 4 specials => 10 + state.
        check_input_budget(FakeAgent(max_len=12), "one two", q)
        with self.assertRaisesRegex(ContractError, "state"):
            check_input_budget(FakeAgent(max_len=12), "one two three", q)

    def test_missing_mask_token_is_rejected(self):
        a = FakeAgent(); a.tok.mask_token = None
        with self.assertRaisesRegex(ContractError, "mask_token"):
            check_input_budget(a, "s", request_body()["questions"])

    def test_invalid_checkpoint_budget_is_rejected(self):
        with self.assertRaises(ContractError):
            check_input_budget(FakeAgent(max_len=1), "s", request_body()["questions"])

    def test_literal_mask_tokens_follow_upstream_neutralization(self):
        check_input_budget(FakeAgent(), "[MASK] blue", request_body()["questions"])


class ContractTests(unittest.TestCase):
    def test_mixed_contract(self):
        self.assertEqual(validate_request(request_body(), "laya"), request_body())

    def test_invalid_shapes(self):
        for value in [None, [], {}, {**request_body(), "response_format": "system_one"}, {**request_body(), "model": "other"}, {**request_body(), "state": None}, {**request_body(), "questions": {}}]:
            with self.subTest(value=value), self.assertRaises(ContractError):
                validate_request(value, "laya")

    def test_invalid_questions(self):
        for q in [{"type": "noul"}, {"type": "text", "instructions": "q"},
                  {"type": "choice", "instructions": "q", "criteria": {}},
                  {"type": "score", "instructions": "q", "criteria": ["one"]},
                  {"type": "noul", "instructions": "q", "criteria": {"maybe": "yes"}},
                  {"type": "noul", "instructions": "q", "unknown": True}]:
            with self.subTest(q=q), self.assertRaises(ContractError):
                validate_request({**request_body(), "questions": {"q": q}}, "laya")

    def test_question_batch_limit(self):
        r = request_body(); r["questions"] = {str(i): {"type": "noul", "instructions": "q"} for i in range(65)}
        with self.assertRaises(ContractError):
            validate_request(r, "laya")

    def test_nonfinite_number(self):
        r = request_body(); r["state"] = {"bad": float("nan")}
        with self.assertRaises(ContractError):
            validate_request(r, "laya")

    def test_runtime_model_identity_and_extra_fields(self):
        code, result = Runtime(FakeAgent()).evaluate(request_body())
        self.assertEqual(code, 200); self.assertEqual(result["model"], "laya")
        self.assertEqual(result["usage"]["output_tokens"], 0)
        self.assertIn("action", result["answers"]["color"])

    def test_runtime_bounded_inference_concurrency(self):
        runtime = Runtime(FakeAgent()); runtime.lock.acquire()
        try:
            self.assertEqual(runtime.evaluate(request_body())[0], 429)
        finally:
            runtime.lock.release()

    def test_invalid_envelope_releases_lock(self):
        agent = FakeAgent(); agent.system_one = lambda *args: None
        runtime = Runtime(agent)
        with self.assertRaises(RuntimeError):
            runtime.evaluate(request_body())
        self.assertFalse(runtime.lock.locked())

    def test_authorization(self):
        runtime = Runtime(FakeAgent(), api_key="test-key")
        self.assertTrue(runtime.authorize("Bearer test-key"))
        for key in [None, "test-key", "Bearer wrong", "Basic test-key"]:
            self.assertFalse(runtime.authorize(key))
        self.assertTrue(Runtime(FakeAgent()).authorize(None))

    def test_public_bind_rejected(self):
        for host in ["0.0.0.0", "192.168.1.10", "example.com", "::"]:
            with self.subTest(host=host), self.assertRaises(ValueError):
                create_server(Runtime(FakeAgent()), host, 0)


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.agent = FakeAgent()
        self.runtime = Runtime(self.agent, api_key="test-key")
        self.server = create_server(self.runtime, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(2)

    def send(self, body=None, path="/v1/systemone", headers=None, method=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        req = Request(self.url + path, data=data, method=method,
                      headers=headers if headers is not None else {"Authorization": "Bearer test-key", "Content-Type": "application/json"})
        try:
            with urlopen(req, timeout=3) as response:
                return response.status, json.loads(response.read())
        except HTTPError as error:
            return error.code, json.loads(error.read())

    def test_post_all_answer_types(self):
        status, body = self.send(request_body())
        self.assertEqual(status, 200); self.assertEqual(set(body["answers"]), {"yes", "color", "count"})

    def test_models_named_identifier(self):
        status, body = self.send(path="/v1/models")
        self.assertEqual(status, 200); self.assertEqual(body["models"][0]["id"], "laya")
        self.assertEqual(body["models"][0]["truncation_policy"], "reject")

    def test_no_key_rejected_without_inference(self):
        status, body = self.send(request_body(), headers={"Content-Type": "application/json"})
        self.assertEqual(status, 401); self.assertEqual(self.agent.calls, [])
        self.assertNotIn("test-key", json.dumps(body))

    def test_wrong_model(self):
        self.assertEqual(self.send({**request_body(), "model": "unknown"})[0], 422)

    def test_long_context(self):
        status, body = self.send({**request_body(), "state": "word " * 1000})
        self.assertEqual(status, 422); self.assertEqual(self.agent.calls, [])
        self.assertIn("no truncation", body["detail"])

    def test_oversized_body(self):
        with socket.create_connection(("127.0.0.1", self.server.server_port)) as sock:
            headers = f"POST /v1/systemone HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test-key\r\nContent-Type: application/json\r\nContent-Length: {MAX_BODY_BYTES + 1}\r\n\r\n"
            sock.sendall(headers.encode())
            self.assertIn(b"413", sock.recv(4096))

    def test_wrong_content_type(self):
        status, _ = self.send(request_body(), headers={"Authorization": "Bearer test-key", "Content-Type": "text/plain"})
        self.assertEqual(status, 415)

    def test_malformed_json(self):
        self.assertEqual(self.send(b"{not json")[0], 422)

    def test_duplicate_json_keys(self):
        body = b'{"model":"laya","model":"other","state":"s","questions":{}}'
        self.assertEqual(self.send(body)[0], 422)

    def test_nonfinite_wire_json(self):
        self.assertEqual(self.send(b'{"model":"laya","state":{"x":NaN},"questions":{}}')[0], 422)

    def test_busy_model_returns_429(self):
        self.runtime.lock.acquire()
        try:
            self.assertEqual(self.send(request_body())[0], 429)
        finally:
            self.runtime.lock.release()

    def test_unknown_route(self):
        self.assertEqual(self.send(path="/unknown")[0], 404)
        self.assertEqual(self.send(request_body(), path="/wrong")[0], 404)

    def test_backend_failure_does_not_echo_secret(self):
        def fail(*args):
            raise RuntimeError("secret-test-key-and-private-prompt")
        self.agent.system_one = fail
        status, body = self.send(request_body())
        self.assertEqual(status, 502); self.assertNotIn("secret", json.dumps(body))

    def test_duplicate_auth_headers(self):
        with socket.create_connection(("127.0.0.1", self.server.server_port)) as sock:
            sock.sendall(b"GET /v1/models HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test-key\r\nAuthorization: Bearer wrong\r\n\r\n")
            self.assertIn(b"401", sock.recv(4096))

    def test_chunked_request_rejected(self):
        with socket.create_connection(("127.0.0.1", self.server.server_port)) as sock:
            sock.sendall(b"POST /v1/systemone HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer test-key\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n")
            self.assertIn(b"400", sock.recv(4096))


if __name__ == "__main__":
    unittest.main(verbosity=2)
