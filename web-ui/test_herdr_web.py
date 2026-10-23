"""Tests for herdr_web.py. Run with: python3 -m unittest discover web-ui"""

from __future__ import annotations

import http.client
import json
import os
import socketserver
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

import herdr_web

PASSWORD = "correct horse"


class FakeHerdr(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """Answers newline-delimited JSON requests like a herdr server."""

    daemon_threads = True

    def __init__(self, path: str):
        self.calls: list[dict] = []
        self.reload_result = {"type": "config_reload", "status": "applied", "diagnostics": []}
        super().__init__(path, FakeHerdrHandler)


class FakeHerdrHandler(socketserver.StreamRequestHandler):
    def handle(self) -> None:
        line = self.rfile.readline()
        if not line:
            return
        request = json.loads(line)
        server: FakeHerdr = self.server  # type: ignore[assignment]
        server.calls.append(request)
        method = request["method"]
        if method == "events.subscribe":
            self.wfile.write(b'{"id":"web_events","result":{"type":"subscription_started"}}\n')
            self.wfile.flush()
            self.rfile.readline()  # hold the stream open until the client goes away
            return
        if method == "session.snapshot":
            result = {"type": "session_snapshot", "snapshot": {"workspaces": [], "tabs": [], "panes": [], "agents": []}}
        elif method == "server.reload_config":
            result = server.reload_result
        elif method == "pane.get":
            response = {"id": request["id"], "error": {"code": "pane_not_found", "message": "pane nope not found"}}
            self.wfile.write((json.dumps(response) + "\n").encode())
            return
        else:
            result = {"type": "ok", "echo": request.get("params")}
        self.wfile.write((json.dumps({"id": request["id"], "result": result}) + "\n").encode())


class BridgeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        tmp = Path(self.tmp.name)
        self.socket_path = tmp / "herdr.sock"
        self.config_path = tmp / "config" / "config.toml"
        self.fake = FakeHerdr(str(self.socket_path))
        threading.Thread(target=self.fake.serve_forever, daemon=True).start()

        args = herdr_web.parse_args(
            ["--socket", str(self.socket_path), "--config", str(self.config_path), "--herdr-bin", "/nonexistent/herdr", "--port", "0"]
        )
        self.app = herdr_web.App(args, PASSWORD)
        self.app.hub.refresh()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), herdr_web.make_handler(self.app))
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]
        self.cookie: str | None = None

    def tearDown(self) -> None:
        self.app.hub.stop()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.fake.shutdown()
        self.fake.server_close()
        self.tmp.cleanup()

    def request(self, method: str, path: str, body: dict | None = None, *, csrf: bool = True, headers: dict | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        all_headers = {"Host": f"127.0.0.1:{self.port}"}
        if csrf:
            all_headers["X-Herdr-Web"] = "1"
        if body is not None:
            all_headers["Content-Type"] = "application/json"
        if self.cookie:
            all_headers["Cookie"] = self.cookie
        all_headers.update(headers or {})
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=all_headers)
        response = conn.getresponse()
        raw = response.read()
        set_cookie = response.getheader("Set-Cookie")
        conn.close()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            data = raw
        return response.status, data, set_cookie

    def login(self) -> None:
        status, _, set_cookie = self.request("POST", "/api/login", {"password": PASSWORD})
        self.assertEqual(status, 200)
        self.assertIsNotNone(set_cookie)
        self.cookie = set_cookie.split(";", 1)[0]


class AuthTests(BridgeTestCase):
    def test_api_requires_login(self) -> None:
        status, data, _ = self.request("GET", "/api/state")
        self.assertEqual(status, 401)
        self.assertEqual(data["error"]["code"], "unauthorized")

    def test_wrong_password_rejected(self) -> None:
        status, data, set_cookie = self.request("POST", "/api/login", {"password": "nope"})
        self.assertEqual(status, 401)
        self.assertEqual(data["error"]["code"], "bad_password")
        self.assertIsNone(set_cookie)

    def test_login_cookie_flags(self) -> None:
        _, _, set_cookie = self.request("POST", "/api/login", {"password": PASSWORD})
        self.assertIn("HttpOnly", set_cookie)
        self.assertIn("SameSite=Strict", set_cookie)
        self.assertNotIn("Secure", set_cookie)

    def test_rate_limit_after_repeated_failures(self) -> None:
        for _ in range(herdr_web.LOGIN_MAX_FAILURES):
            self.request("POST", "/api/login", {"password": "nope"})
        status, data, _ = self.request("POST", "/api/login", {"password": PASSWORD})
        self.assertEqual(status, 429)
        self.assertEqual(data["error"]["code"], "rate_limited")

    def test_post_without_custom_header_rejected(self) -> None:
        status, data, _ = self.request("POST", "/api/login", {"password": PASSWORD}, csrf=False)
        self.assertEqual(status, 403)
        self.assertEqual(data["error"]["code"], "forbidden")

    def test_cross_origin_post_rejected(self) -> None:
        self.login()
        status, _, _ = self.request(
            "POST", "/api/call", {"method": "ping"}, headers={"Sec-Fetch-Site": "cross-site"}
        )
        self.assertEqual(status, 403)

    def test_logout_invalidates_session(self) -> None:
        self.login()
        self.request("POST", "/api/logout", {})
        status, _, _ = self.request("GET", "/api/state")
        self.assertEqual(status, 401)


class CallTests(BridgeTestCase):
    def test_state_reports_snapshot(self) -> None:
        self.login()
        status, data, _ = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertTrue(data["online"])
        self.assertEqual(data["snapshot"]["workspaces"], [])

    def test_allowed_method_is_forwarded(self) -> None:
        self.login()
        params = {"pane_id": "w1:p1", "text": "ls"}
        status, data, _ = self.request("POST", "/api/call", {"method": "pane.send_text", "params": params})
        self.assertEqual(status, 200)
        self.assertEqual(data["result"]["echo"], params)
        self.assertIn("pane.send_text", [call["method"] for call in self.fake.calls])

    def test_disallowed_method_is_not_forwarded(self) -> None:
        self.login()
        status, data, _ = self.request("POST", "/api/call", {"method": "server.stop"})
        self.assertEqual(status, 403)
        self.assertEqual(data["error"]["code"], "method_not_allowed")
        self.assertNotIn("server.stop", [call["method"] for call in self.fake.calls])

    def test_herdr_error_is_passed_through(self) -> None:
        self.login()
        # pane.get is not on the allowlist; call the client directly to check error mapping.
        with self.assertRaises(herdr_web.HerdrError) as ctx:
            self.app.client.call("pane.get", {"pane_id": "nope"})
        self.assertEqual(ctx.exception.code, "pane_not_found")

    def test_offline_herdr_reported(self) -> None:
        self.login()
        self.fake.shutdown()
        self.fake.server_close()
        os.unlink(self.socket_path)
        self.app.hub.refresh()
        status, data, _ = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertFalse(data["online"])
        status, data, _ = self.request("POST", "/api/call", {"method": "ping"})
        self.assertEqual(status, 502)
        self.assertEqual(data["error"]["code"], "server_unavailable")


@unittest.skipIf(herdr_web.tomllib is None, "TOML validation needs Python 3.11+")
class ConfigTests(BridgeTestCase):
    def test_invalid_toml_is_not_written(self) -> None:
        self.login()
        status, data, _ = self.request("POST", "/api/config", {"text": "[ui\n"})
        self.assertEqual(status, 400)
        self.assertEqual(data["error"]["code"], "invalid_toml")
        self.assertFalse(self.config_path.exists())

    def test_save_backup_and_restore(self) -> None:
        self.login()
        status, data, _ = self.request("POST", "/api/config", {"text": "onboarding = false\n"})
        self.assertEqual(status, 200)
        self.assertEqual(data["reload"]["status"], "applied")
        self.assertEqual(self.config_path.read_text(), "onboarding = false\n")

        self.fake.reload_result = {"type": "config_reload", "status": "partial", "diagnostics": ["bad sidebar_width"]}
        status, data, _ = self.request("POST", "/api/config", {"text": "[ui]\nsidebar_width = 40\n"})
        self.assertEqual(data["reload"], {"status": "partial", "diagnostics": ["bad sidebar_width"]})

        status, data, _ = self.request("POST", "/api/config/restore", {})
        self.assertEqual(status, 200)
        self.assertEqual(self.config_path.read_text(), "onboarding = false\n")

    def test_read_reports_missing_file(self) -> None:
        self.login()
        status, data, _ = self.request("GET", "/api/config")
        self.assertEqual(status, 200)
        self.assertFalse(data["exists"])
        self.assertEqual(data["path"], str(self.config_path))


class StaticTests(BridgeTestCase):
    def test_index_served_with_csp(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/")
        response = conn.getresponse()
        body = response.read()
        self.assertEqual(response.status, 200)
        self.assertIn(b"herdr", body)
        self.assertIn("script-src 'self'", response.getheader("Content-Security-Policy"))
        conn.close()

    def test_path_traversal_falls_back_to_index(self) -> None:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        conn.request("GET", "/../herdr_web.py")
        response = conn.getresponse()
        body = response.read()
        self.assertNotIn(b"import", body)
        self.assertIn(b"<!doctype html>", body)
        conn.close()


class OptionTests(unittest.TestCase):
    def test_plain_http_on_public_address_refused(self) -> None:
        with mock.patch("sys.stderr"), self.assertRaises(SystemExit):
            herdr_web.parse_args(["--host", "0.0.0.0"])

    def test_plain_http_on_public_address_allowed_with_flag(self) -> None:
        args = herdr_web.parse_args(["--host", "0.0.0.0", "--allow-plain-http-remote"])
        self.assertEqual(args.host, "0.0.0.0")

    def test_loopback_hosts(self) -> None:
        self.assertTrue(herdr_web.is_loopback("127.0.0.1"))
        self.assertTrue(herdr_web.is_loopback("::1"))
        self.assertTrue(herdr_web.is_loopback("localhost"))
        self.assertFalse(herdr_web.is_loopback("0.0.0.0"))
        self.assertFalse(herdr_web.is_loopback("100.64.1.2"))

    def test_socket_resolution_order(self) -> None:
        with mock.patch.dict(os.environ, {"HERDR_SOCKET_PATH": "/env/herdr.sock", "XDG_CONFIG_HOME": "/cfg"}, clear=False):
            self.assertEqual(herdr_web.resolve_socket_path(None, "work"), Path("/cfg/herdr/sessions/work/herdr.sock"))
            self.assertEqual(herdr_web.resolve_socket_path(None, None), Path("/env/herdr.sock"))
            self.assertEqual(herdr_web.resolve_socket_path("/x.sock", "work"), Path("/x.sock"))


if __name__ == "__main__":
    unittest.main()
