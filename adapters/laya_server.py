"""Loopback System One HTTP adapter for the Laya Python runtime.

Run from the repository root:
    python3 -m adapters.laya_server --port 8010 --model laya

No FastAPI or web-server dependency is required. Model loading is explicit and never
falls back to a fixture. This is a local sidecar, NOT a public production HTTP server.
"""
from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import math
import os
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

MAX_BODY_BYTES = 1_000_000
MAX_RESPONSE_BYTES = 2_000_000
MAX_QUESTIONS = 64


class ContractError(ValueError):
    """An input cannot be evaluated without losing information."""


def _json_content(value: Any) -> None:
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ContractError("Non-finite JSON number")
        return
    if isinstance(value, list):
        for item in value:
            _json_content(item)
        return
    if isinstance(value, dict) and all(isinstance(key, str) for key in value):
        for item in value.values():
            _json_content(item)
        return
    raise ContractError("Unsupported JSON value")


def validate_request(request: Any, model: str, max_questions: int = MAX_QUESTIONS) -> dict:
    if not isinstance(request, dict) or set(request) != {"model", "state", "questions"}:
        raise ContractError("Required fields are model, state, questions; unknown fields are rejected")
    if request["model"] != model:
        raise ContractError("Unknown model; use the identifier returned by /v1/models")
    if not isinstance(request["state"], (str, dict, list)):
        raise ContractError("state must be string, object or array")
    questions = request["questions"]
    if not isinstance(questions, dict) or not 1 <= len(questions) <= max_questions:
        raise ContractError(f"questions must contain 1..{max_questions} entries; split larger batches")
    _json_content(request)
    for qid, question in questions.items():
        if not isinstance(qid, str) or not 1 <= len(qid) <= 256:
            raise ContractError("Invalid question identifier")
        if (not isinstance(question, dict) or "instructions" not in question
                or not set(question) <= {"type", "instructions", "criteria"}):
            raise ContractError("Invalid question shape")
        kind = question.get("type")
        criteria = question.get("criteria")
        if kind == "choice":
            if not isinstance(criteria, dict) or not 1 <= len(criteria) <= 255:
                raise ContractError("Choice requires 1..255 options (token budgets still apply)")
        elif kind == "score":
            if not isinstance(criteria, list) or not 2 <= len(criteria) <= 255:
                raise ContractError("Score requires 2..255 levels (token budgets still apply)")
        elif kind == "noul":
            if criteria is not None and (not isinstance(criteria, dict) or not set(criteria) <= {"true", "false"}):
                raise ContractError("Noul accepts only true/false criteria")
        else:
            raise ContractError("Unknown question type")
    return request


def _render(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


def _criterion(value: Any) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def _options(question: dict) -> list[str]:
    criteria = question.get("criteria")
    if question["type"] == "choice":
        return [key if value is None or value == "" else f"{key}: {_criterion(value)}"
                for key, value in criteria.items()]
    if question["type"] == "score":
        return [f"level {i}: {_criterion(value)}" for i, value in enumerate(criteria)]
    criteria = criteria or {}
    return [f"{label}: " + (_criterion(criteria[label]) if criteria.get(label) not in (None, "") else default)
            for label, default in [("false", "no, the statement does not hold"),
                                   ("true", "yes, the statement holds")]]


def check_input_budget(agent: Any, state: Any, questions: dict) -> None:
    """Reject ANY truncation of instructions, options, or state before inference.

    Mirrors the inspected Laya common.build_sequence token allocation, not a
    character estimate. The adapter uses one fixed loaded checkpoint. It deliberately
    does not silently chunk a judgment or increase a checkpoint's trained max_len.
    """
    tokenizer = agent.tok
    max_len = int(agent.cfg.get("max_len", 512))
    head_max = int(agent.cfg.get("head_max_len", 192))
    mask = tokenizer.mask_token
    if not isinstance(mask, str) or not mask:
        raise ContractError("Tokenizer must expose a nonempty mask_token")
    if max_len < 8 or head_max < 16:
        raise ContractError("Invalid checkpoint sequence limits")

    def tokens(text: str) -> int:
        return len(tokenizer(text.replace(mask, " "), add_special_tokens=False)["input_ids"])

    state_tokens = tokens(_render(state))
    for question in questions.values():
        instructions = question["instructions"]
        # Agent._to_internal uses json.dumps with its default ensure_ascii=True.
        if not isinstance(instructions, str):
            instructions = json.dumps(instructions)
        instruction_tokens = tokens(f"{question['type']} question: {instructions}")
        option_lengths = [tokens(" " + option) for option in _options(question)]
        if any(length > 48 for length in option_lengths):
            raise ContractError("Laya would truncate an option beyond 48 tokens; shorten the rubric")
        option_total = sum(length + 1 for length in option_lengths)  # one mask marker per option
        instruction_budget = head_max - option_total
        if instruction_budget < 16 or instruction_tokens > max(8, instruction_budget):
            raise ContractError("Laya would truncate the question/options head; shorten the question or option set")
        total = instruction_tokens + option_total + state_tokens + 4  # CLS and three SEP tokens
        if total > max_len:
            raise ContractError("Laya would truncate the state; provide smaller complete evidence")


class Runtime:
    def __init__(self, agent: Any, model: str = "laya", api_key: str | None = None):
        if not model or len(model) > 200:
            raise ValueError("Invalid model identifier")
        self.agent = agent
        self.model = model
        self.api_key = api_key
        self.lock = threading.Lock()

    def authorize(self, header: str | None) -> bool:
        if not self.api_key:
            return True
        expected = f"Bearer {self.api_key}".encode("utf-8")
        return hmac.compare_digest((header or "").encode("utf-8"), expected)

    def models(self) -> dict:
        return {"models": [{"id": self.model, "backend": "laya-python",
                             "max_len": self.agent.cfg.get("max_len", 512),
                             "head_max_len": self.agent.cfg.get("head_max_len", 192),
                             "max_questions": MAX_QUESTIONS, "truncation_policy": "reject"}]}

    def evaluate(self, request: Any) -> tuple[int, dict]:
        validate_request(request, self.model)
        # Fail fast rather than queue an unbounded number of GPU tasks.
        if not self.lock.acquire(blocking=False):
            return 429, {"error": "model_busy"}
        try:
            check_input_budget(self.agent, request["state"], request["questions"])
            result = self.agent.system_one(request["state"], request["questions"])
            if not isinstance(result, dict) or not isinstance(result.get("answers"), dict):
                raise RuntimeError("Invalid Laya result envelope")
            return 200, {**result, "model": self.model}
        finally:
            self.lock.release()


def _unique_pairs(pairs: list[tuple[str, Any]]) -> dict:
    out = {}
    for key, value in pairs:
        if key in out:
            raise ContractError("Duplicate JSON key")
        out[key] = value
    return out


def create_server(runtime: Runtime, host: str = "127.0.0.1", port: int = 8010) -> ThreadingHTTPServer:
    # No accidental public bind; put a deliberate authenticated TLS proxy in front for remote use.
    if host == "localhost":
        host = "127.0.0.1"
    try:
        if not ipaddress.ip_address(host).is_loopback:
            raise ValueError("Laya adapter binds only to loopback")
    except ValueError as error:
        raise ValueError("Laya adapter requires a numeric loopback address") from error

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def setup(self) -> None:
            super().setup()
            self.connection.settimeout(10)

        def log_message(self, _format: str, *_args: Any) -> None:
            pass  # No prompts, paths, bodies or Authorization headers in access logs.

        def reply(self, status: int, payload: dict) -> None:
            data = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            if len(data) > MAX_RESPONSE_BYTES:
                status, data = 502, b'{"error":"response_too_large"}'
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Connection", "close")
            if status == 429:
                self.send_header("Retry-After", "1")
            self.end_headers()
            self.close_connection = True
            self.wfile.write(data)

        def authorized(self) -> bool:
            headers = self.headers.get_all("Authorization", [])
            if len(headers) > 1 or not runtime.authorize(headers[0] if headers else None):
                self.reply(401, {"error": "unauthorized"})
                return False
            return True

        def do_GET(self) -> None:
            if not self.authorized():
                return
            if self.path != "/v1/models":
                self.reply(404, {"error": "not_found"})
                return
            self.reply(200, runtime.models())

        def do_POST(self) -> None:
            if not self.authorized():
                return
            if self.path != "/v1/systemone":
                self.reply(404, {"error": "not_found"})
                return
            try:
                lengths = self.headers.get_all("Content-Length", [])
                if self.headers.get("Transfer-Encoding") or len(lengths) != 1 or not lengths[0].isdigit():
                    self.reply(400, {"error": "one_content_length_required"})
                    return
                length = int(lengths[0])
                if not 0 < length <= MAX_BODY_BYTES:
                    self.reply(413, {"error": "request_too_large_or_empty"})
                    return
                if self.headers.get_content_type() != "application/json":
                    self.reply(415, {"error": "json_required"})
                    return
                raw = self.rfile.read(length)
                if len(raw) != length:
                    self.reply(400, {"error": "incomplete_body"})
                    return
                request = json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_pairs,
                                     parse_constant=lambda _: (_ for _ in ()).throw(ContractError("Non-finite JSON")))
                status, result = runtime.evaluate(request)
                self.reply(status, result)
            except (ContractError, ValueError, UnicodeError, RecursionError):
                # Intentionally omit raw input and backend exceptions from responses.
                self.reply(422, {"error": "invalid_request_or_context_budget", "detail": "Check model, typed questions and token budgets; no truncation was applied"})
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                self.close_connection = True
            except Exception:
                self.reply(502, {"error": "model_inference_failed"})

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        block_on_close = True
        address_family = socket.AF_INET6 if ":" in host else socket.AF_INET

        def __init__(self, *args: Any, **kwargs: Any):
            self.slots = threading.BoundedSemaphore(16)
            super().__init__(*args, **kwargs)

        def process_request(self, request: socket.socket, client_address: Any) -> None:
            if not self.slots.acquire(blocking=False):
                self.shutdown_request(request)
                return
            try:
                super().process_request(request, client_address)
            except BaseException:
                self.slots.release()
                raise

        def process_request_thread(self, request: socket.socket, client_address: Any) -> None:
            try:
                super().process_request_thread(request, client_address)
            finally:
                self.slots.release()

    return Server((host, port), Handler)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8010)
    parser.add_argument("--model", default="laya", help="Public adapter model identifier")
    parser.add_argument("--checkpoint", default="convaiinnovations/laya")
    parser.add_argument("--subfolder", choices=["multilingual", "typed-decisions"])
    parser.add_argument("--device", help="Passed to laya.load, e.g. cuda or cpu")
    args = parser.parse_args()
    # Avoid TensorFlow probing in the model stack. Never select a synthetic backend.
    os.environ.setdefault("USE_TF", "0")
    import laya  # Optional dependency installed only for this sidecar.
    agent = laya.load(args.checkpoint, subfolder=args.subfolder, device=args.device)
    runtime = Runtime(agent, args.model, os.environ.get("SYSTEM_ONE_API_KEY"))
    server = create_server(runtime, args.host, args.port)
    print(f"Laya adapter listening on {args.host}:{server.server_port}; truncation=reject", file=sys.stderr, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
