"""Group chat rooms for herdr-web.

A room is a project folder shared by the user and several AI command-line
tools. Each tool is run in its official non-interactive mode (``claude -p``,
``codex exec``, ``grok -p``) with structured output, so replies render as chat
bubbles instead of terminal screens. Every tool keeps its own resumable
session; before each turn it is told what the other members said since its
previous turn, which is what lets them build on each other's work.
"""

from __future__ import annotations

import json
import logging
import os
import re
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Callable

log = logging.getLogger("herdr-web.chat")

# Display data for each supported tool, keyed by herdr agent kind.
AGENTS = {
    "claude": {"name": "Claude", "login": "claude"},
    "codex": {"name": "ChatGPT", "login": "codex login"},
    "grok": {"name": "Grok", "login": "grok login"},
}

MAX_CONTEXT_MESSAGES = 30
MAX_CONTEXT_CHARS = 24000
MAX_ACTIVITY = 200
# A tool that waits for an approval nobody can give would otherwise hang the room.
TURN_TIMEOUT_SECONDS = 30 * 60
LOGIN_HINTS = re.compile(
    r"not signed in|not logged in|please run /login|invalid api key|401 unauthorized|missing bearer|"
    r"authentication|log in|login required",
    re.IGNORECASE,
)


def default_data_dir() -> Path:
    override = os.environ.get("HERDR_WEB_DATA")
    if override:
        return Path(override).expanduser()
    mac = Path.home() / "Library" / "Application Support" / "herdr-web"
    if mac.parent.is_dir():
        return mac
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local" / "share")
    return Path(base) / "herdr-web"


def now() -> float:
    return round(time.time(), 3)


class ChatError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


# --- command lines ----------------------------------------------------------


def build_command(kind: str, exe: str, prompt: str, session: str | None, new_session: str, allow_edits: bool, folder: str) -> list[str]:
    """The non-interactive invocation for one turn of one tool."""
    if kind == "claude":
        command = [exe, "-p", prompt, "--output-format", "stream-json", "--verbose"]
        command += ["--permission-mode", "acceptEdits" if allow_edits else "default"]
        command += ["--resume", session] if session else ["--session-id", new_session]
        return command
    if kind == "grok":
        command = [exe, "-p", prompt, "--output-format", "streaming-messages-json", "--cwd", folder]
        command += ["--permission-mode", "acceptEdits" if allow_edits else "default"]
        command += ["--resume", session] if session else ["--session-id", new_session]
        return command
    if kind == "codex":
        sandbox = f'sandbox_mode="{"workspace-write" if allow_edits else "read-only"}"'
        if session:
            return [exe, "exec", "resume", "--json", "--skip-git-repo-check", "-c", sandbox, session, prompt]
        return [exe, "exec", "--json", "--skip-git-repo-check", "-c", sandbox, "-C", folder, prompt]
    raise ChatError("unknown_agent", f"unsupported agent {kind}")


# --- output parsing ---------------------------------------------------------


def _short(value: object, limit: int = 80) -> str:
    text = " ".join(str(value).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _name(path: object) -> str:
    text = str(path)
    return text.rstrip("/").rsplit("/", 1)[-1] or text


def describe_tool(name: str, data: object) -> str:
    """A short plain-language line for a tool call shown under a bubble."""
    args = data if isinstance(data, dict) else {}
    lowered = name.lower()
    path = args.get("file_path") or args.get("path") or args.get("notebook_path") or args.get("target_file")
    if lowered in ("read", "read_file", "view", "cat"):
        return f"讀取 {_name(path)}" if path else "讀取檔案"
    if lowered in ("write", "write_file", "create_file"):
        return f"建立 {_name(path)}" if path else "建立檔案"
    if lowered in ("edit", "multiedit", "edit_file", "str_replace", "apply_patch", "notebookedit"):
        return f"修改 {_name(path)}" if path else "修改檔案"
    if lowered in ("bash", "shell", "run_command", "exec", "terminal"):
        command = args.get("command") or args.get("cmd")
        return f"執行指令：{_short(command)}" if command else "執行指令"
    if lowered in ("grep", "glob", "search", "find", "list_dir", "ls"):
        pattern = args.get("pattern") or args.get("query") or path
        return f"搜尋：{_short(pattern)}" if pattern else "搜尋檔案"
    if lowered in ("websearch", "web_search"):
        return f"上網搜尋：{_short(args.get('query', ''))}"
    if lowered in ("webfetch", "web_fetch", "fetch"):
        return f"讀取網頁：{_short(args.get('url', ''))}"
    if lowered in ("todowrite", "task", "agent", "plan"):
        return "規劃工作步驟"
    return f"使用工具：{name}"


class TurnParser:
    """Turns one tool's JSON lines into reply text, activity lines and errors."""

    def __init__(self, kind: str):
        self.kind = kind
        self.texts: list[str] = []
        self.activity: list[str] = []
        self.session: str | None = None
        self.error: str | None = None
        self.finished = False

    @property
    def text(self) -> str:
        return "\n\n".join(part.strip() for part in self.texts if part.strip())

    def feed(self, line: str) -> bool:
        """Parse one line; return True when it changed what the user sees."""
        line = line.strip()
        if not line.startswith("{"):
            return False
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return False
        if not isinstance(event, dict):
            return False
        if self.kind == "codex":
            return self._feed_codex(event)
        return self._feed_messages(event)

    def _feed_messages(self, event: dict) -> bool:
        kind = event.get("type")
        if kind == "system" and event.get("subtype") == "init":
            self.session = event.get("session_id") or self.session
            return False
        if kind == "assistant":
            changed = False
            for block in (event.get("message") or {}).get("content") or []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "text" and block.get("text"):
                    self.texts.append(block["text"])
                    changed = True
                elif block.get("type") == "tool_use":
                    self.activity.append(describe_tool(str(block.get("name", "")), block.get("input")))
                    changed = True
            return changed
        if kind == "result":
            self.finished = True
            self.session = event.get("session_id") or self.session
            if event.get("is_error"):
                errors = event.get("errors") or []
                detail = "；".join(str(item) for item in errors) if errors else str(event.get("result") or event.get("subtype") or "error")
                self.error = detail
            elif not self.texts and event.get("result"):
                self.texts.append(str(event["result"]))
            return True
        if kind == "error":
            self.error = str(event.get("message") or "error")
            return True
        return False

    def _feed_codex(self, event: dict) -> bool:
        kind = event.get("type")
        if kind == "thread.started":
            self.session = event.get("thread_id") or self.session
            return False
        if kind in ("item.started", "item.completed"):
            item = event.get("item") or {}
            item_type = item.get("type")
            if kind == "item.completed" and item_type == "agent_message" and item.get("text"):
                self.texts.append(item["text"])
                return True
            if kind == "item.started" and item_type == "command_execution":
                self.activity.append(f"執行指令：{_short(item.get('command', ''))}")
                return True
            if kind == "item.completed" and item_type == "file_change":
                paths = [_name(change.get("path", "")) for change in item.get("changes") or [] if isinstance(change, dict)]
                self.activity.append(f"修改 {', '.join(paths)}" if paths else "修改檔案")
                return True
            if kind == "item.started" and item_type == "web_search":
                self.activity.append(f"上網搜尋：{_short(item.get('query', ''))}")
                return True
            if kind == "item.started" and item_type == "mcp_tool_call":
                self.activity.append(f"使用工具：{item.get('tool', '')}")
                return True
            return False
        if kind == "turn.completed":
            self.finished = True
            return True
        if kind == "turn.failed":
            self.finished = True
            self.error = str((event.get("error") or {}).get("message") or "turn failed")
            return True
        if kind == "error":
            message = str(event.get("message") or "")
            # Codex retries forever-ish on auth failures; surface them at once.
            if "401" in message or "Unauthorized" in message:
                self.error = message
                return True
        return False


# --- rooms ------------------------------------------------------------------


def _message(sender: str, text: str = "", status: str = "done") -> dict:
    return {"id": uuid.uuid4().hex[:12], "from": sender, "text": text, "activity": [], "status": status, "error": None, "error_kind": None, "at": now(), "rev": 0}


class Room:
    def __init__(self, data: dict):
        self.data = data
        self.lock = threading.RLock()
        self.cond = threading.Condition(self.lock)
        self.queue: list[tuple[str, str | None]] = []
        self.process: subprocess.Popen | None = None
        self.stopping = False
        self.worker: threading.Thread | None = None

    @property
    def id(self) -> str:
        return self.data["id"]

    def bump(self, message: dict | None = None) -> None:
        """Record a change; caller holds the lock."""
        self.data["rev"] = self.data.get("rev", 0) + 1
        if message is not None:
            message["rev"] = self.data["rev"]
        self.data["updated_at"] = now()
        self.cond.notify_all()

    def meta(self) -> dict:
        with self.lock:
            data = {key: value for key, value in self.data.items() if key not in ("messages", "sessions", "seen")}
            data["busy"] = bool(self.queue) or self.process is not None
            data["queued"] = [kind for kind, _ in self.queue]
            return data

    def changes_since(self, rev: int) -> dict:
        with self.lock:
            return {
                "room": self.meta(),
                "messages": [dict(message) for message in self.data["messages"] if message.get("rev", 0) > rev],
                "rev": self.data.get("rev", 0),
            }

    def wait(self, rev: int, timeout: float) -> int:
        with self.cond:
            self.cond.wait_for(lambda: self.data.get("rev", 0) != rev, timeout=timeout)
            return self.data.get("rev", 0)


class ChatManager:
    """Owns the rooms, their files on disk and the per-room worker threads."""

    def __init__(self, data_dir: Path, find_agent: Callable[[str], str | None]):
        self.dir = data_dir / "rooms"
        self.find_agent = find_agent
        self.rooms: dict[str, Room] = {}
        self.lock = threading.Lock()
        self._load()

    # persistence

    def _load(self) -> None:
        if not self.dir.is_dir():
            return
        for path in sorted(self.dir.glob("*.json")):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                log.warning("skipping unreadable room %s: %s", path, exc)
                continue
            for message in data.get("messages", []):
                if message.get("status") in ("running", "queued"):
                    message["status"] = "error"
                    message["error"] = "herdr 控制台重新啟動時中斷了"
            self.rooms[data["id"]] = Room(data)

    def save(self, room: Room) -> None:
        with room.lock:
            payload = json.dumps(room.data, ensure_ascii=False, indent=1)
        self.dir.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=".room.")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(payload)
            os.replace(tmp, self.dir / f"{room.id}.json")
        except BaseException:
            if os.path.exists(tmp):
                os.unlink(tmp)
            raise

    # rooms

    def list(self) -> list[dict]:
        rooms = [room.meta() for room in self.rooms.values()]
        for meta, room in zip(rooms, self.rooms.values()):
            with room.lock:
                last = room.data["messages"][-1] if room.data["messages"] else None
            meta["last"] = {"from": last["from"], "text": last["text"][:80]} if last else None
        return sorted(rooms, key=lambda meta: meta.get("updated_at", 0), reverse=True)

    def get(self, room_id: str) -> Room:
        room = self.rooms.get(room_id)
        if not room:
            raise ChatError("room_not_found", "找不到這個聊天室")
        return room

    def create(self, name: str, folder: str, members: list[str], allow_edits: bool) -> Room:
        name = name.strip()[:60]
        target = Path(folder).expanduser()
        if not target.is_dir():
            raise ChatError("not_a_directory", f"{folder} 不是資料夾")
        members = [kind for kind in members if kind in AGENTS]
        if not members:
            raise ChatError("no_members", "至少要選一個 AI")
        room_id = uuid.uuid4().hex[:12]
        room = Room(
            {
                "id": room_id,
                "name": name or target.name,
                "folder": str(target.resolve()),
                "members": members,
                "allow_edits": bool(allow_edits),
                "created_at": now(),
                "updated_at": now(),
                "rev": 0,
                "messages": [],
                "sessions": {},
                "seen": {},
            }
        )
        with self.lock:
            self.rooms[room_id] = room
        self.save(room)
        return room

    def update(self, room_id: str, changes: dict) -> Room:
        room = self.get(room_id)
        with room.lock:
            if "name" in changes and str(changes["name"]).strip():
                room.data["name"] = str(changes["name"]).strip()[:60]
            if "allow_edits" in changes:
                room.data["allow_edits"] = bool(changes["allow_edits"])
            if "members" in changes:
                members = [kind for kind in changes["members"] if kind in AGENTS]
                if members:
                    room.data["members"] = members
            room.bump()
        self.save(room)
        return room

    def delete(self, room_id: str) -> None:
        self.stop(room_id)  # also raises when the room does not exist
        with self.lock:
            self.rooms.pop(room_id, None)
        try:
            (self.dir / f"{room_id}.json").unlink()
        except FileNotFoundError:
            pass

    # conversation

    def post(self, room_id: str, text: str, targets: list[str]) -> dict:
        room = self.get(room_id)
        text = text.strip()
        if not text:
            raise ChatError("empty", "訊息是空的")
        with room.lock:
            targets = [kind for kind in targets if kind in room.data["members"]]
            message = _message("user", text)
            room.data["messages"].append(message)
            room.bump(message)
            for kind in targets:
                room.queue.append((kind, None))
                self._placeholder(room, kind)
        self.save(room)
        self._ensure_worker(room)
        return message

    def discuss(self, room_id: str, targets: list[str]) -> None:
        room = self.get(room_id)
        with room.lock:
            targets = [kind for kind in targets if kind in room.data["members"]] or list(room.data["members"])
            note = "請看看其他成員最新的發言，說說你同意、不同意或要補充的地方；如果大家已經有共識，就提出下一步。"
            for kind in targets:
                room.queue.append((kind, note))
                self._placeholder(room, kind)
        self._ensure_worker(room)

    def stop(self, room_id: str) -> None:
        room = self.get(room_id)
        with room.lock:
            room.queue.clear()
            room.stopping = True
            for message in room.data["messages"]:
                if message["status"] == "queued":
                    message["status"] = "cancelled"
                    room.bump(message)
            process = room.process
        if process and process.poll() is None:
            _terminate(process)

    def _placeholder(self, room: Room, kind: str) -> None:
        message = _message(kind, status="queued")
        room.data["messages"].append(message)
        room.bump(message)

    def _ensure_worker(self, room: Room) -> None:
        with room.lock:
            room.stopping = False
            if room.worker and room.worker.is_alive():
                return
            room.worker = threading.Thread(target=self._work, args=(room,), name=f"room-{room.id}", daemon=True)
            room.worker.start()

    def _work(self, room: Room) -> None:
        while True:
            with room.lock:
                if not room.queue:
                    room.bump()
                    return
                kind, note = room.queue.pop(0)
                message = next(
                    (item for item in room.data["messages"] if item["from"] == kind and item["status"] == "queued"),
                    None,
                )
                if message is None:
                    continue
                message["status"] = "running"
                message["at"] = now()
                room.bump(message)
            try:
                self._run_turn(room, kind, message, note)
            except Exception as exc:  # keep the worker alive for the next turn
                log.exception("turn failed")
                with room.lock:
                    message["status"] = "error"
                    message["error"] = str(exc)
                    room.bump(message)
            self.save(room)

    def compose_prompt(self, room: Room, kind: str, note: str | None, upto: int) -> str:
        """What one tool is told before its turn: who is here and what is new."""
        with room.lock:
            data = room.data
            first = kind not in data["sessions"]
            seen = data["seen"].get(kind, 0)
            history = [
                item for item in data["messages"][seen:upto]
                if item["from"] != kind and item["status"] == "done" and item["text"]
            ]
            members = [AGENTS[member]["name"] for member in data["members"]]
            name = AGENTS[kind]["name"]
            folder, allow = data["folder"], data["allow_edits"]
        history = history[-MAX_CONTEXT_MESSAGES:]
        lines = []
        for item in history:
            speaker = "使用者" if item["from"] == "user" else AGENTS.get(item["from"], {}).get("name", item["from"])
            lines.append(f"[{speaker}]：{item['text']}")
        transcript = "\n\n".join(lines)
        if len(transcript) > MAX_CONTEXT_CHARS:
            transcript = "…（較早的內容省略）\n" + transcript[-MAX_CONTEXT_CHARS:]
        parts = []
        if first:
            parts.append(
                f"你是群組聊天室「{data['name']}」裡的 {name}。成員：使用者、{'、'.join(members)}。"
                f"大家共用資料夾 {folder}。"
                + ("你可以讀取和修改這個資料夾裡的檔案。" if allow else "目前只能讀取檔案，不能修改。")
                + "其他成員的發言會用「[名字]：內容」的格式轉述給你。請用繁體中文、簡潔地回覆，"
                "需要別的成員接手時可以直接說明要誰做什麼。"
            )
        if transcript:
            parts.append(("你上次發言後聊天室的新訊息：\n\n" if not first else "目前的對話：\n\n") + transcript)
        parts.append(f"（主持人）{note}" if note else f"請以 {name} 的身分回覆上面最新的訊息。")
        return "\n\n".join(parts)

    def _run_turn(self, room: Room, kind: str, message: dict, note: str | None) -> None:
        exe = self.find_agent(kind)
        if not exe:
            with room.lock:
                message["status"] = "error"
                message["error"] = f"這台電腦還沒有安裝 {AGENTS[kind]['name']} 的命令列工具。"
                message["error_kind"] = "missing"
                room.bump(message)
            return
        with room.lock:
            upto = room.data["messages"].index(message)
            session = room.data["sessions"].get(kind)
            folder, allow = room.data["folder"], room.data["allow_edits"]
        prompt = self.compose_prompt(room, kind, note, upto)
        new_session = str(uuid.uuid4())
        with room.lock:
            if room.stopping:
                message["status"] = "cancelled"
                room.bump(message)
                return
        command = build_command(kind, exe, prompt, session, new_session, allow, folder)
        parser = TurnParser(kind)
        env = dict(os.environ, NO_COLOR="1", TERM="dumb")
        process = subprocess.Popen(
            command,
            cwd=folder,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            start_new_session=True,
        )
        stderr_tail: list[str] = []
        drain = threading.Thread(target=_drain, args=(process.stderr, stderr_tail), daemon=True)
        drain.start()
        with room.lock:
            room.process = process
        timed_out = threading.Event()

        def on_timeout() -> None:
            timed_out.set()
            _terminate(process)

        timer = threading.Timer(TURN_TIMEOUT_SECONDS, on_timeout)
        timer.daemon = True
        timer.start()
        try:
            assert process.stdout is not None
            for line in process.stdout:
                if not parser.feed(line):
                    continue
                with room.lock:
                    message["text"] = parser.text
                    message["activity"] = parser.activity[-MAX_ACTIVITY:]
                    room.bump(message)
                if parser.error and kind == "codex" and not parser.finished:
                    _terminate(process)
                    break
            process.wait()
            drain.join(timeout=2)
        finally:
            timer.cancel()
            with room.lock:
                room.process = None
            for stream in (process.stdout, process.stderr):
                if stream:
                    stream.close()
        with room.lock:
            stopped = room.stopping
            message["text"] = parser.text
            message["activity"] = parser.activity[-MAX_ACTIVITY:]
            error = parser.error
            if timed_out.is_set():
                error = f"超過 {TURN_TIMEOUT_SECONDS // 60} 分鐘沒有完成，已自動停止。可能是在等待某個權限確認。"
            if not error and process.returncode not in (0, None) and not parser.text:
                error = "".join(stderr_tail).strip()[-600:] or f"結束代碼 {process.returncode}"
            if stopped and not parser.text:
                message["status"] = "cancelled"
            elif error and (not parser.text or timed_out.is_set()):
                message["status"] = "error"
                message["error"] = error[-600:]
                message["error_kind"] = "login" if LOGIN_HINTS.search(error) else "failed"
            else:
                message["status"] = "done"
                if parser.session or not session:
                    room.data["sessions"][kind] = parser.session or new_session
                room.data["seen"][kind] = upto + 1
            room.bump(message)


def _drain(stream, tail: list[str]) -> None:
    for line in stream:
        tail.append(line)
        if len(tail) > 40:
            del tail[:20]


def _terminate(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
