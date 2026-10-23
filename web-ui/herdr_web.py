#!/usr/bin/env python3
"""herdr-web: a small browser dashboard for a running herdr server.

The bridge talks to herdr only through its public JSON socket API
(newline-delimited JSON over a Unix socket) and serves a static single-page
app. It has no third-party dependencies; Python 3.9+ is enough, and 3.11+
adds TOML validation for the config editor.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import re
import secrets
import shlex
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlsplit

try:
    import tomllib  # Python 3.11+
except ModuleNotFoundError:  # pragma: no cover - depends on interpreter
    tomllib = None

__version__ = "0.2.2"

log = logging.getLogger("herdr-web")

STATIC_DIR = Path(__file__).resolve().parent / "static"
SESSION_COOKIE = "herdr_web_session"
SESSION_TTL_SECONDS = 7 * 24 * 3600
LOGIN_WINDOW_SECONDS = 600
LOGIN_MAX_FAILURES = 10
MAX_BODY_BYTES = 1024 * 1024
POLL_INTERVAL_SECONDS = 2.0
DEFAULT_SOCKET_TIMEOUT = 10.0

# Socket API methods the browser may call through /api/call. Anything that
# stops the server or changes plugins and detection manifests stays CLI-only.
ALLOWED_METHODS = frozenset(
    {
        "ping",
        "session.snapshot",
        "workspace.create",
        "workspace.focus",
        "workspace.rename",
        "workspace.close",
        "tab.create",
        "tab.focus",
        "tab.rename",
        "tab.close",
        "pane.split",
        "pane.focus",
        "pane.rename",
        "pane.read",
        "pane.send_text",
        "pane.send_keys",
        "pane.close",
        "agent.list",
        "agent.get",
        "agent.prompt",
        "agent.start",
        "agent.send_keys",
        "server.reload_config",
    }
)

DEFAULT_PREFERRED_AGENTS = "claude,codex,grok"

FALLBACK_AGENT_KINDS = [
    "claude", "codex", "gemini", "opencode", "cursor", "copilot", "amp",
    "pi", "devin", "cline", "droid", "grok", "kimi", "kiro", "qwen",
]

# The AI tools offered on the home screen: herdr agent kind -> the official
# installer, run visibly in a new pane. Codex has no standalone installer, so
# install_codex.py unpacks OpenAI's native npm platform package without Node.js.
CODEX_INSTALLER = Path(__file__).resolve().parent / "install_codex.py"
AGENT_INSTALLERS = {
    "claude": "curl -fsSL https://claude.ai/install.sh | bash",
    "codex": f"{shlex.quote(sys.executable)} {shlex.quote(str(CODEX_INSTALLER))}",
    "grok": "curl -fsSL https://x.ai/cli/install.sh | bash",
}
AGENT_DETECT_TTL_SECONDS = 60
MAX_DIR_ENTRIES = 500

LIFECYCLE_EVENTS = [
    "workspace.created", "workspace.updated", "workspace.renamed",
    "workspace.moved", "workspace.reordered", "workspace.closed",
    "workspace.focused", "tab.created", "tab.closed", "tab.focused",
    "tab.renamed", "tab.moved", "pane.created", "pane.closed",
    "pane.updated", "pane.focused", "pane.moved", "pane.exited",
    "pane.agent_detected", "layout.updated",
]

CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".webmanifest": "application/manifest+json",
}


class HerdrError(Exception):
    """An error reported by herdr or by the socket transport."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def default_config_dir() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")
    return Path(base) / "herdr"


def resolve_socket_path(explicit: str | None, session: str | None) -> Path:
    """Follow herdr's resolution order: --session, HERDR_SOCKET_PATH, HERDR_SESSION."""
    if explicit:
        return Path(explicit).expanduser()
    config_dir = default_config_dir()
    if session:
        return config_dir / "sessions" / session / "herdr.sock"
    env_path = os.environ.get("HERDR_SOCKET_PATH")
    if env_path:
        return Path(env_path).expanduser()
    env_session = os.environ.get("HERDR_SESSION")
    if env_session:
        return config_dir / "sessions" / env_session / "herdr.sock"
    return config_dir / "herdr.sock"


class HerdrClient:
    """One short-lived socket connection per request keeps calls thread-safe."""

    def __init__(self, socket_path: Path):
        self.socket_path = socket_path
        self._counter = 0
        self._lock = threading.Lock()

    def _next_id(self) -> str:
        with self._lock:
            self._counter += 1
            return f"web_{self._counter}"

    def connect(self, timeout: float) -> socket.socket:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        try:
            sock.connect(str(self.socket_path))
        except (FileNotFoundError, ConnectionRefusedError) as exc:
            sock.close()
            raise HerdrError("server_unavailable", f"herdr server is not running ({exc.strerror})") from exc
        except OSError as exc:
            sock.close()
            raise HerdrError("server_unavailable", f"cannot reach herdr socket: {exc}") from exc
        return sock

    def call(self, method: str, params: dict | None = None, timeout: float = DEFAULT_SOCKET_TIMEOUT) -> dict:
        request = {"id": self._next_id(), "method": method, "params": params or {}}
        sock = self.connect(timeout)
        try:
            sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
            with sock.makefile("rb") as reader:
                line = reader.readline()
        except socket.timeout as exc:
            raise HerdrError("timeout", f"herdr did not answer {method} in time") from exc
        except OSError as exc:
            raise HerdrError("server_unavailable", f"herdr connection failed: {exc}") from exc
        finally:
            sock.close()
        if not line:
            raise HerdrError("server_unavailable", "herdr closed the connection without a response")
        try:
            response = json.loads(line)
        except json.JSONDecodeError as exc:
            raise HerdrError("bad_response", "herdr sent an unreadable response") from exc
        if "error" in response:
            error = response["error"] or {}
            raise HerdrError(str(error.get("code", "error")), str(error.get("message", "unknown error")))
        return response.get("result", {})


class StateHub:
    """Caches session.snapshot and wakes SSE listeners when it changes.

    A lifecycle event subscription marks the cache dirty for fast updates; a
    periodic poll covers agent status changes, which herdr only emits per pane.
    """

    def __init__(self, client: HerdrClient, poll_interval: float = POLL_INTERVAL_SECONDS):
        self.client = client
        self.poll_interval = poll_interval
        self._cond = threading.Condition()
        self._dirty = threading.Event()
        self._stop = threading.Event()
        self.version = 0
        self.payload: dict = {"online": False, "error": "connecting", "snapshot": None}
        self._digest = ""

    def start(self) -> None:
        threading.Thread(target=self._poll_loop, name="herdr-poll", daemon=True).start()
        threading.Thread(target=self._event_loop, name="herdr-events", daemon=True).start()

    def stop(self) -> None:
        self._stop.set()
        self._dirty.set()

    def invalidate(self) -> None:
        self._dirty.set()

    def refresh(self) -> None:
        try:
            result = self.client.call("session.snapshot")
            payload = {"online": True, "error": None, "snapshot": result.get("snapshot")}
        except HerdrError as exc:
            payload = {"online": False, "error": exc.message, "snapshot": None}
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()
        with self._cond:
            if digest != self._digest:
                self._digest = digest
                self.payload = payload
                self.version += 1
                self._cond.notify_all()

    def wait_for_change(self, seen_version: int, timeout: float) -> tuple[int, dict]:
        with self._cond:
            self._cond.wait_for(lambda: self.version != seen_version or self._stop.is_set(), timeout=timeout)
            return self.version, self.payload

    def current(self) -> tuple[int, dict]:
        with self._cond:
            return self.version, self.payload

    def _poll_loop(self) -> None:
        while not self._stop.is_set():
            self.refresh()
            self._dirty.wait(self.poll_interval)
            self._dirty.clear()

    def _event_loop(self) -> None:
        backoff = 1.0
        request = {
            "id": "web_events",
            "method": "events.subscribe",
            "params": {"subscriptions": [{"type": name} for name in LIFECYCLE_EVENTS]},
        }
        while not self._stop.is_set():
            try:
                sock = self.client.connect(timeout=30)
            except HerdrError:
                self._stop.wait(backoff)
                backoff = min(backoff * 2, 15.0)
                continue
            try:
                sock.sendall((json.dumps(request) + "\n").encode("utf-8"))
                sock.settimeout(None)
                with sock.makefile("rb") as reader:
                    for _event in reader:
                        backoff = 1.0
                        self._dirty.set()
                        if self._stop.is_set():
                            break
            except OSError:
                pass
            finally:
                sock.close()
            # Lost events or a restarted server: resync through the snapshot.
            self._dirty.set()
            self._stop.wait(backoff)


class AuthManager:
    def __init__(self, password: str):
        self._password_digest = hashlib.sha256(password.encode("utf-8")).digest()
        self._sessions: dict[str, float] = {}
        self._failures: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def check_password(self, candidate: str) -> bool:
        digest = hashlib.sha256(candidate.encode("utf-8")).digest()
        return hmac.compare_digest(digest, self._password_digest)

    def login_allowed(self, client_ip: str) -> bool:
        now = time.monotonic()
        with self._lock:
            recent = [t for t in self._failures.get(client_ip, []) if now - t < LOGIN_WINDOW_SECONDS]
            self._failures[client_ip] = recent
            return len(recent) < LOGIN_MAX_FAILURES

    def record_failure(self, client_ip: str) -> None:
        with self._lock:
            self._failures.setdefault(client_ip, []).append(time.monotonic())

    def create_session(self) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._sessions[token] = time.time() + SESSION_TTL_SECONDS
        return token

    def valid_session(self, token: str | None) -> bool:
        if not token:
            return False
        now = time.time()
        with self._lock:
            expiry = self._sessions.get(token)
            if expiry is None:
                return False
            if expiry < now:
                del self._sessions[token]
                return False
            return True

    def end_session(self, token: str | None) -> None:
        if token:
            with self._lock:
                self._sessions.pop(token, None)


class ConfigStore:
    """Reads and writes herdr's config.toml, keeping one backup of the previous version."""

    def __init__(self, path: Path, herdr_bin: str):
        self.path = path
        self.backup_path = path.with_name(path.name + ".web-backup")
        self.herdr_bin = herdr_bin
        self._lock = threading.Lock()

    def read(self) -> dict:
        exists = self.path.exists()
        text = self.path.read_text(encoding="utf-8") if exists else ""
        return {
            "path": str(self.path),
            "exists": exists,
            "text": text,
            "has_backup": self.backup_path.exists(),
            "can_validate": tomllib is not None,
        }

    @staticmethod
    def validate(text: str) -> str | None:
        if tomllib is None:
            return None
        try:
            tomllib.loads(text)
        except tomllib.TOMLDecodeError as exc:
            return str(exc)
        return None

    def write(self, text: str) -> None:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self.path.exists():
                shutil.copy2(self.path, self.backup_path)
            fd, tmp = tempfile.mkstemp(dir=self.path.parent, prefix=".config.toml.")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(text)
                if self.path.exists():
                    shutil.copymode(self.path, tmp)
                os.replace(tmp, self.path)
            except BaseException:
                if os.path.exists(tmp):
                    os.unlink(tmp)
                raise

    def restore_backup(self) -> bool:
        with self._lock:
            if not self.backup_path.exists():
                return False
            shutil.copy2(self.backup_path, self.path)
            return True

    def default_config(self) -> str:
        try:
            done = subprocess.run(
                [self.herdr_bin, "--default-config"], capture_output=True, text=True, timeout=15, check=False
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise HerdrError("herdr_bin", f"cannot run {self.herdr_bin}: {exc}") from exc
        if done.returncode != 0:
            raise HerdrError("herdr_bin", done.stderr.strip() or "herdr --default-config failed")
        return done.stdout


def detect_agent_kinds(herdr_bin: str) -> list[str]:
    try:
        done = subprocess.run(
            [herdr_bin, "agent", "start", "--help"], capture_output=True, text=True, timeout=15, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return FALLBACK_AGENT_KINDS
    match = re.search(r"possible values: ([^\]]+)\]", done.stdout)
    if not match:
        return FALLBACK_AGENT_KINDS
    kinds = [kind.strip() for kind in match.group(1).split(",") if kind.strip()]
    return kinds or FALLBACK_AGENT_KINDS


def order_agent_kinds(kinds: list[str], preferred: list[str]) -> tuple[list[str], list[str]]:
    """Put the preferred kinds herdr supports first; return (ordered kinds, preferred kinds)."""
    chosen = [kind for kind in preferred if kind in kinds]
    return chosen + [kind for kind in kinds if kind not in chosen], chosen


def login_shell() -> str:
    shell = os.environ.get("SHELL")
    if shell and os.path.exists(shell):
        return shell
    for candidate in ("/bin/zsh", "/bin/bash", "/bin/sh"):
        if os.path.exists(candidate):
            return candidate
    return "/bin/sh"


def find_commands(names: list[str]) -> dict[str, str | None]:
    """Locate commands the way a new herdr pane would: through the user's login shell.

    Tools installed by npm, nvm or installers that edit ~/.zshrc are often missing
    from this process's PATH, especially when it was started from Finder.
    """
    found: dict[str, str | None] = {name: shutil.which(name) for name in names}
    script = "for a in %s; do printf '__herdr_web__ %%s=%%s\\n' \"$a\" \"$(command -v \"$a\" 2>/dev/null)\"; done" % " ".join(
        shlex.quote(name) for name in names
    )
    try:
        done = subprocess.run(
            [login_shell(), "-lic", script],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return found
    for line in done.stdout.splitlines():
        if not line.startswith("__herdr_web__ "):
            continue
        name, _, location = line[len("__herdr_web__ ") :].partition("=")
        if name in found and location.strip():
            found[name] = location.strip()
    return found


class AgentCatalog:
    """Which of the home-screen AI tools are installed, cached for a minute."""

    def __init__(self, kinds: list[str]):
        self.kinds = kinds
        self._lock = threading.Lock()
        self._cached: dict | None = None
        self._cached_at = 0.0

    def status(self, refresh: bool = False) -> dict:
        with self._lock:
            if not refresh and self._cached and time.monotonic() - self._cached_at < AGENT_DETECT_TTL_SECONDS:
                return self._cached
        found = find_commands(self.kinds + ["npm", "brew"])
        agents = []
        for kind in self.kinds:
            install = AGENT_INSTALLERS.get(kind)
            agents.append({"kind": kind, "installed": bool(found.get(kind)), "path": found.get(kind), "install": install})
        result = {"agents": agents, "has_npm": bool(found.get("npm")), "has_brew": bool(found.get("brew"))}
        with self._lock:
            self._cached = result
            self._cached_at = time.monotonic()
        return result


def list_directories(raw_path: str | None) -> dict:
    """List the sub-folders of a folder, for the folder picker."""
    home = Path.home()
    target = Path(raw_path).expanduser() if raw_path else home
    try:
        target = target.resolve()
        if not target.is_dir():
            raise HerdrError("not_a_directory", f"{target} is not a folder")
        names = []
        with os.scandir(target) as entries:
            for entry in entries:
                if entry.name.startswith("."):
                    continue
                try:
                    if entry.is_dir():
                        names.append(entry.name)
                except OSError:
                    continue
    except PermissionError as exc:
        raise HerdrError("permission_denied", f"no permission to open {target}") from exc
    except OSError as exc:
        raise HerdrError("not_a_directory", str(exc)) from exc
    names.sort(key=str.casefold)
    shortcuts = [{"label": "主資料夾", "path": str(home)}]
    for label, name in (("桌面", "Desktop"), ("文件", "Documents"), ("下載", "Downloads")):
        candidate = home / name
        if candidate.is_dir():
            shortcuts.append({"label": label, "path": str(candidate)})
    parent = str(target.parent) if target.parent != target else None
    return {
        "path": str(target),
        "name": target.name or str(target),
        "parent": parent,
        "entries": names[:MAX_DIR_ENTRIES],
        "truncated": len(names) > MAX_DIR_ENTRIES,
        "shortcuts": shortcuts,
    }


def create_directory(parent: str, name: str) -> Path:
    """Create a new sub-folder for the folder picker and return its path."""
    name = name.strip()
    if not name or name in (".", "..") or "/" in name or "\0" in name or name.startswith(".") or len(name) > 100:
        raise HerdrError("invalid_name", "folder names cannot be empty, start with a dot, or contain /")
    base = Path(parent).expanduser()
    if not base.is_dir():
        raise HerdrError("not_a_directory", f"{base} is not a folder")
    target = base / name
    try:
        target.mkdir(exist_ok=True)
    except PermissionError as exc:
        raise HerdrError("permission_denied", f"no permission to create a folder in {base}") from exc
    except OSError as exc:
        raise HerdrError("create_failed", str(exc)) from exc
    if not target.is_dir():
        raise HerdrError("create_failed", f"{target} exists and is not a folder")
    return target


class App:
    def __init__(self, args: argparse.Namespace, password: str):
        self.args = args
        self.client = HerdrClient(resolve_socket_path(args.socket, args.session))
        self.hub = StateHub(self.client)
        self.auth = AuthManager(password)
        config_path = Path(args.config).expanduser() if args.config else default_config_dir() / "config.toml"
        self.config = ConfigStore(config_path, args.herdr_bin)
        preferred = [kind.strip() for kind in args.preferred_agents.split(",") if kind.strip()]
        self.agent_kinds, self.preferred_agents = order_agent_kinds(detect_agent_kinds(args.herdr_bin), preferred)
        self.catalog = AgentCatalog(self.preferred_agents)
        self.secure_cookie = bool(args.tls_cert) or args.secure_cookie

    def start_herdr_server(self) -> None:
        command = [self.args.herdr_bin]
        if self.args.session:
            command += ["--session", self.args.session]
        command.append("server")
        try:
            subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        except OSError as exc:
            raise HerdrError("herdr_bin", f"cannot start {self.args.herdr_bin}: {exc}") from exc

    def ensure_herdr_running(self, wait_seconds: float = 8.0) -> bool:
        """Start the herdr server when nothing answers on its socket; return whether it is up."""
        try:
            self.client.call("ping", timeout=2)
            return True
        except HerdrError:
            pass
        self.start_herdr_server()
        deadline = time.monotonic() + wait_seconds
        while time.monotonic() < deadline:
            time.sleep(0.25)
            try:
                self.client.call("ping", timeout=2)
                return True
            except HerdrError:
                continue
        return False


class Handler(BaseHTTPRequestHandler):
    server_version = "herdr-web"
    sys_version = ""
    app: App  # set on the subclass created by make_handler

    # --- helpers -----------------------------------------------------------

    def log_message(self, fmt: str, *args) -> None:  # route through logging
        log.info("%s %s", self.client_ip(), fmt % args)

    def client_ip(self) -> str:
        return self.client_address[0] if self.client_address else "?"

    def cookie_token(self) -> str | None:
        header = self.headers.get("Cookie", "")
        for part in header.split(";"):
            name, _, value = part.strip().partition("=")
            if name == SESSION_COOKIE:
                return value
        return None

    def authenticated(self) -> bool:
        return self.app.auth.valid_session(self.cookie_token())

    def security_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
            "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        )

    def send_json(self, status: int, body: dict, extra_headers: list[tuple[str, str]] | None = None) -> None:
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.security_headers()
        for name, value in extra_headers or []:
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def send_error_json(self, status: int, code: str, message: str) -> None:
        self.send_json(status, {"error": {"code": code, "message": message}})

    def read_json(self) -> dict | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY_BYTES:
            self.send_error_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "too_large", "request body too large")
            return None
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "bad_json", "request body must be JSON")
            return None
        if not isinstance(body, dict):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "bad_json", "request body must be a JSON object")
            return None
        return body

    def same_origin(self) -> bool:
        """Reject cross-site writes.

        Browsers cannot attach the custom header cross-origin without a CORS
        preflight, which this server never approves. Sec-Fetch-Site is checked
        instead of Origin because reverse proxies often rewrite Host.
        """
        if self.headers.get("X-Herdr-Web") != "1":
            return False
        return self.headers.get("Sec-Fetch-Site", "same-origin") in ("same-origin", "none")

    def session_cookie(self, token: str, max_age: int) -> str:
        parts = [f"{SESSION_COOKIE}={token}", "Path=/", "HttpOnly", "SameSite=Strict", f"Max-Age={max_age}"]
        if self.app.secure_cookie:
            parts.append("Secure")
        return "; ".join(parts)

    # --- routing -----------------------------------------------------------

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        path = url.path
        query = parse_qs(url.query)
        if path.startswith("/api/"):
            if path == "/api/session":
                self.send_json(HTTPStatus.OK, {"authenticated": self.authenticated(), "version": __version__})
                return
            if not self.authenticated():
                self.send_error_json(HTTPStatus.UNAUTHORIZED, "unauthorized", "login required")
                return
            if path == "/api/state":
                version, payload = self.app.hub.current()
                self.send_json(HTTPStatus.OK, {"version": version, **payload})
            elif path == "/api/events":
                self.stream_events()
            elif path == "/api/meta":
                self.send_json(
                    HTTPStatus.OK,
                    {
                        "agent_kinds": self.app.agent_kinds,
                        "preferred_agents": self.app.preferred_agents,
                        "socket_path": str(self.app.client.socket_path),
                        "session": self.app.args.session,
                    },
                )
            elif path == "/api/agents":
                self.send_json(HTTPStatus.OK, self.app.catalog.status(refresh="refresh" in query))
            elif path == "/api/dirs":
                try:
                    self.send_json(HTTPStatus.OK, list_directories((query.get("path") or [None])[0]))
                except HerdrError as exc:
                    self.send_error_json(HTTPStatus.BAD_REQUEST, exc.code, exc.message)
            elif path == "/api/config":
                self.send_json(HTTPStatus.OK, self.app.config.read())
            elif path == "/api/config/default":
                try:
                    self.send_json(HTTPStatus.OK, {"text": self.app.config.default_config()})
                except HerdrError as exc:
                    self.send_error_json(HTTPStatus.BAD_GATEWAY, exc.code, exc.message)
            else:
                self.send_error_json(HTTPStatus.NOT_FOUND, "not_found", "unknown endpoint")
            return
        self.serve_static(path)

    def do_POST(self) -> None:
        path = urlsplit(self.path).path
        if not path.startswith("/api/"):
            self.send_error_json(HTTPStatus.NOT_FOUND, "not_found", "unknown endpoint")
            return
        if not self.same_origin():
            self.send_error_json(HTTPStatus.FORBIDDEN, "forbidden", "cross-origin request rejected")
            return
        body = self.read_json()
        if body is None:
            return
        if path == "/api/login":
            self.handle_login(body)
            return
        if path == "/api/logout":
            self.app.auth.end_session(self.cookie_token())
            self.send_json(HTTPStatus.OK, {"ok": True}, [("Set-Cookie", self.session_cookie("", 0))])
            return
        if not self.authenticated():
            self.send_error_json(HTTPStatus.UNAUTHORIZED, "unauthorized", "login required")
            return
        if path == "/api/call":
            self.handle_call(body)
        elif path == "/api/config":
            self.handle_config_save(body)
        elif path == "/api/config/validate":
            text = body.get("text")
            if not isinstance(text, str):
                self.send_error_json(HTTPStatus.BAD_REQUEST, "invalid_params", "text must be a string")
                return
            error = ConfigStore.validate(text)
            self.send_json(HTTPStatus.OK, {"valid": error is None, "error": error, "checked": tomllib is not None})
        elif path == "/api/dirs/create":
            parent, name = body.get("parent"), body.get("name")
            if not isinstance(parent, str) or not isinstance(name, str):
                self.send_error_json(HTTPStatus.BAD_REQUEST, "invalid_params", "parent and name must be strings")
                return
            try:
                created = create_directory(parent, name)
                self.send_json(HTTPStatus.OK, list_directories(str(created)))
            except HerdrError as exc:
                self.send_error_json(HTTPStatus.BAD_REQUEST, exc.code, exc.message)
        elif path == "/api/config/restore":
            self.handle_config_restore()
        elif path == "/api/server/start":
            try:
                self.app.start_herdr_server()
            except HerdrError as exc:
                self.send_error_json(HTTPStatus.BAD_GATEWAY, exc.code, exc.message)
                return
            self.app.hub.invalidate()
            self.send_json(HTTPStatus.OK, {"ok": True})
        else:
            self.send_error_json(HTTPStatus.NOT_FOUND, "not_found", "unknown endpoint")

    # --- handlers ----------------------------------------------------------

    def handle_login(self, body: dict) -> None:
        ip = self.client_ip()
        if not self.app.auth.login_allowed(ip):
            self.send_error_json(HTTPStatus.TOO_MANY_REQUESTS, "rate_limited", "too many failed logins; try later")
            return
        password = body.get("password")
        if not isinstance(password, str) or not self.app.auth.check_password(password):
            self.app.auth.record_failure(ip)
            log.warning("failed login from %s", ip)
            self.send_error_json(HTTPStatus.UNAUTHORIZED, "bad_password", "wrong password")
            return
        token = self.app.auth.create_session()
        self.send_json(HTTPStatus.OK, {"ok": True}, [("Set-Cookie", self.session_cookie(token, SESSION_TTL_SECONDS))])

    def handle_call(self, body: dict) -> None:
        method = body.get("method")
        params = body.get("params") or {}
        if not isinstance(method, str) or method not in ALLOWED_METHODS:
            self.send_error_json(HTTPStatus.FORBIDDEN, "method_not_allowed", f"method {method!r} is not available here")
            return
        if not isinstance(params, dict):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "invalid_params", "params must be an object")
            return
        timeout = DEFAULT_SOCKET_TIMEOUT
        if method == "agent.start":
            timeout_ms = params.get("timeout_ms")
            timeout = (timeout_ms if isinstance(timeout_ms, int) and timeout_ms > 0 else 30000) / 1000 + 5
        try:
            result = self.app.client.call(method, params, timeout=timeout)
        except HerdrError as exc:
            status = HTTPStatus.BAD_GATEWAY if exc.code in ("server_unavailable", "timeout") else HTTPStatus.BAD_REQUEST
            self.send_error_json(status, exc.code, exc.message)
            return
        if method not in ("pane.read", "agent.list", "agent.get", "ping", "session.snapshot"):
            self.app.hub.invalidate()
        self.send_json(HTTPStatus.OK, {"result": result})

    def handle_config_save(self, body: dict) -> None:
        text = body.get("text")
        if not isinstance(text, str):
            self.send_error_json(HTTPStatus.BAD_REQUEST, "invalid_params", "text must be a string")
            return
        error = ConfigStore.validate(text)
        if error:
            self.send_error_json(HTTPStatus.BAD_REQUEST, "invalid_toml", error)
            return
        try:
            self.app.config.write(text)
        except OSError as exc:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "write_failed", str(exc))
            return
        self.send_json(HTTPStatus.OK, {"saved": True, "reload": self.reload_config()})

    def handle_config_restore(self) -> None:
        try:
            restored = self.app.config.restore_backup()
        except OSError as exc:
            self.send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, "write_failed", str(exc))
            return
        if not restored:
            self.send_error_json(HTTPStatus.NOT_FOUND, "no_backup", "there is no previous version to restore")
            return
        self.send_json(HTTPStatus.OK, {"restored": True, "reload": self.reload_config()})

    def reload_config(self) -> dict:
        try:
            result = self.app.client.call("server.reload_config")
        except HerdrError as exc:
            return {"status": "not_applied", "diagnostics": [exc.message]}
        return {"status": result.get("status"), "diagnostics": result.get("diagnostics") or []}

    def stream_events(self) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.security_headers()
        self.end_headers()
        seen = -1
        try:
            while True:
                version, payload = self.app.hub.wait_for_change(seen, timeout=20)
                if version != seen:
                    seen = version
                    data = json.dumps({"version": version, **payload})
                    self.wfile.write(f"event: state\ndata: {data}\n\n".encode("utf-8"))
                else:
                    self.wfile.write(b": keepalive\n\n")
                self.wfile.flush()
                if not self.app.auth.valid_session(self.cookie_token()):
                    return
        except (BrokenPipeError, ConnectionResetError, ssl.SSLError, OSError):
            return

    def serve_static(self, path: str) -> None:
        if path in ("", "/"):
            path = "/index.html"
        target = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR not in target.parents or not target.is_file():
            target = STATIC_DIR / "index.html"
        data = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", CONTENT_TYPES.get(target.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.security_headers()
        self.end_headers()
        self.wfile.write(data)


def make_handler(app: App) -> type[Handler]:
    return type("BoundHandler", (Handler,), {"app": app})


def is_loopback(host: str) -> bool:
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def load_password(args: argparse.Namespace) -> tuple[str, bool]:
    """Return (password, generated)."""
    if args.password_file:
        password = Path(args.password_file).expanduser().read_text(encoding="utf-8").strip()
        if password:
            return password, False
        raise SystemExit(f"password file {args.password_file} is empty")
    env_password = os.environ.get("HERDR_WEB_PASSWORD", "").strip()
    if env_password:
        return env_password, False
    return secrets.token_urlsafe(12), True


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Browser dashboard for a running herdr server.")
    parser.add_argument("--host", default="127.0.0.1", help="address to listen on (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8787, help="port to listen on (default: 8787)")
    parser.add_argument("--session", help="herdr named session to manage")
    parser.add_argument("--socket", help="explicit herdr socket path (overrides --session)")
    parser.add_argument("--config", help="herdr config.toml path (default: ~/.config/herdr/config.toml)")
    parser.add_argument("--herdr-bin", default=shutil.which("herdr") or "herdr", help="herdr executable")
    parser.add_argument("--password-file", help="file holding the login password (else HERDR_WEB_PASSWORD)")
    parser.add_argument("--tls-cert", help="TLS certificate (PEM) to serve HTTPS directly")
    parser.add_argument("--tls-key", help="TLS private key (PEM)")
    parser.add_argument(
        "--secure-cookie",
        action="store_true",
        help="mark the session cookie Secure (use when an HTTPS reverse proxy sits in front)",
    )
    parser.add_argument(
        "--allow-plain-http-remote",
        action="store_true",
        help="allow listening on a non-loopback address without TLS (not recommended)",
    )
    parser.add_argument(
        "--preferred-agents",
        default=DEFAULT_PREFERRED_AGENTS,
        help=f"comma-separated agent kinds listed first in the UI (default: {DEFAULT_PREFERRED_AGENTS})",
    )
    parser.add_argument(
        "--start-server",
        action="store_true",
        help="start the herdr server first when it is not running",
    )
    parser.add_argument(
        "--open",
        action="store_true",
        help="open the dashboard in the default browser, already logged in",
    )
    args = parser.parse_args(argv)
    if bool(args.tls_cert) != bool(args.tls_key):
        parser.error("--tls-cert and --tls-key must be given together")
    if not is_loopback(args.host) and not args.tls_cert and not args.allow_plain_http_remote:
        parser.error(
            f"refusing to serve plain HTTP on {args.host}: the password and session would travel unencrypted. "
            "Keep the default 127.0.0.1 and use an SSH tunnel, Tailscale, or an HTTPS reverse proxy, "
            "or pass --tls-cert/--tls-key, or --allow-plain-http-remote if you accept the risk."
        )
    return args


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    args = parse_args(argv)
    password, generated = load_password(args)
    app = App(args, password)
    if args.start_server:
        try:
            if app.ensure_herdr_running():
                print("herdr server is running", flush=True)
            else:
                print("herdr server did not start in time; the dashboard will keep retrying", flush=True)
        except HerdrError as exc:
            print(f"could not start herdr server: {exc.message}", flush=True)
    app.hub.start()

    try:
        httpd = ThreadingHTTPServer((args.host, args.port), make_handler(app))
    except OSError as exc:
        app.hub.stop()
        print(
            f"cannot listen on {args.host}:{args.port} ({exc.strerror}). "
            "herdr-web may already be running; open it in the browser, or pick another --port.",
            file=sys.stderr,
            flush=True,
        )
        return 1
    httpd.daemon_threads = True
    port = httpd.server_address[1]
    scheme = "http"
    if args.tls_cert:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(args.tls_cert, args.tls_key)
        httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    browse_host = "127.0.0.1" if args.host in ("0.0.0.0", "::", "") else args.host
    host_for_url = f"[{browse_host}]" if ":" in browse_host else browse_host
    url = f"{scheme}://{host_for_url}:{port}/"
    print(f"herdr-web listening on {url}", flush=True)
    print(f"herdr socket: {app.client.socket_path}", flush=True)
    if generated:
        print(f"generated login password (set HERDR_WEB_PASSWORD to choose one): {password}", flush=True)
    if args.open:
        # A per-run generated password rides in the URL fragment, which browsers
        # never send to the server; the page logs in with it and strips it from
        # history. A password the user chose is never put in a URL.
        login_url = f"{url}#login={quote(password, safe='')}" if generated else url
        if not webbrowser.open(login_url):
            print(f"open this address to log in: {login_url}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        app.hub.stop()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
