"""Regression: numeric loopback HTTP servers must not consult system reverse DNS."""
import http.client
import socket
import threading
import unittest
from unittest.mock import patch
from adapters.laya_server import create_server


class StubRuntime:
    def authorize(self, header):
        return True

    def models(self):
        return {"models": [{"id": "offline-test"}]}


class LoopbackStartupTests(unittest.TestCase):
    def test_no_reverse_dns_before_listen(self):
        with patch("socket.getfqdn", side_effect=AssertionError("reverse DNS forbidden")) as lookup:
            server = create_server(StubRuntime(), port=0)
            try:
                self.assertEqual(server.server_name, "127.0.0.1")
                self.assertGreater(server.server_port, 0)
                lookup.assert_not_called()
            finally:
                server.server_close()

    def test_actual_http_without_reverse_dns(self):
        with patch("socket.getfqdn", side_effect=RuntimeError("resolver unavailable")) as lookup:
            server = create_server(StubRuntime(), port=0)
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            thread.start()
            client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=2)
            try:
                client.request("GET", "/v1/models")
                response = client.getresponse()
                self.assertEqual(response.status, 200)
                self.assertIn(b"offline-test", response.read())
                lookup.assert_not_called()
            finally:
                client.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())

    def test_localhost_normalized_before_numeric_bind(self):
        with patch("socket.getfqdn", side_effect=AssertionError("reverse DNS forbidden")):
            server = create_server(StubRuntime(), host="localhost", port=0)
            try:
                self.assertEqual(server.server_address[0], "127.0.0.1")
            finally:
                server.server_close()

    def test_public_bind_still_rejected_without_dns(self):
        with patch("socket.getfqdn", side_effect=AssertionError("reverse DNS forbidden")):
            for host in ["0.0.0.0", "192.168.1.1", "example.com"]:
                with self.subTest(host=host), self.assertRaises(ValueError):
                    create_server(StubRuntime(), host=host, port=0)

    def test_occupied_port_still_fails_without_dns(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        try:
            with patch("socket.getfqdn", side_effect=AssertionError("reverse DNS forbidden")):
                with self.assertRaises(OSError):
                    create_server(StubRuntime(), port=listener.getsockname()[1])
        finally:
            listener.close()
