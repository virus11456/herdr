"""Tests for chat.py, using fake claude/codex/grok programs that speak each
tool's JSON output format. Run with: python3 -m unittest discover web-ui"""

from __future__ import annotations

import http.client
import json
import os
import sys
import tempfile
import textwrap
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

import chat
import herdr_web

FAKE_AGENT = textwrap.dedent(
    r'''
    #!PYTHON
    import json, os, sys, time, uuid
    kind = os.path.basename(sys.argv[0])
    args = sys.argv[1:]
    log = os.environ["FAKE_AGENT_LOG"]
    with open(log, "a") as handle:
        handle.write(json.dumps({"kind": kind, "args": args, "cwd": os.getcwd()}) + "\n")
    mode = os.environ.get("FAKE_AGENT_MODE", "ok")
    def out(obj):
        print(json.dumps(obj), flush=True)
    if kind == "gemini":
        if mode == "login":
            sys.stderr.write("Please set an Auth method in your settings.json\n")
            sys.exit(0)
        session = args[args.index("--resume") + 1] if "--resume" in args else args[args.index("--session-id") + 1]
        out({"type": "init", "session_id": session, "model": "gemini"})
        out({"type": "message", "role": "user", "content": "x"})
        out({"type": "message", "role": "assistant", "content": "Gemini ", "delta": True})
        out({"type": "message", "role": "assistant", "content": "先看一下", "delta": True})
        out({"type": "tool_use", "tool_name": "read_file", "parameters": {"file_path": "/a/notes.md"}})
        out({"type": "tool_result", "status": "success", "output": "..."})
        out({"type": "message", "role": "assistant", "content": "看完了", "delta": True})
        out({"type": "result", "status": "success"})
        sys.exit(0)
    if kind == "codex":
        prompt = args[-1]
        thread = args[args.index("resume") + 4] if "resume" in args else str(uuid.uuid4())
        out({"type": "thread.started", "thread_id": thread})
        out({"type": "turn.started"})
        if mode == "login":
            for _ in range(3):
                out({"type": "error", "message": "Reconnecting... (unexpected status 401 Unauthorized: Missing bearer)"})
            time.sleep(5)
            sys.exit(1)
        out({"type": "item.started", "item": {"type": "command_execution", "command": "ls -la"}})
        out({"type": "item.completed", "item": {"type": "agent_message", "text": "ChatGPT 看到：" + prompt[-40:]}})
        out({"type": "turn.completed", "usage": {}})
        sys.exit(0)
    prompt = args[args.index("-p") + 1]
    session = None
    for flag in ("--resume", "--session-id"):
        if flag in args:
            session = args[args.index(flag) + 1]
    if mode == "login":
        out({"type": "system", "subtype": "init", "session_id": ""})
        out({"type": "result", "subtype": "error_during_execution", "is_error": True, "errors": ["Not signed in. Run grok login."]})
        sys.exit(0)
    if mode == "slow":
        time.sleep(30)
    out({"type": "system", "subtype": "init", "session_id": session})
    out({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Read", "input": {"file_path": "/x/README.md"}}]}})
    name = "Claude" if kind == "claude" else "Grok"
    text = name + " 看到：" + prompt[-40:]
    if "你是這個聊天室的隊長" in prompt and (mode == "always_assign" or "你分派的工作都回報了" not in prompt):
        text = "分工如下：\n1. @ChatGPT：檢查 index.html 的標題\n- **@Grok**：查三個競品網站\n```\n@Claude：這行在程式碼區塊裡，不算\n```"
    elif "你分派的工作都回報了" in prompt:
        text = "總結：大家都完成了"
    out({"type": "assistant", "message": {"content": [{"type": "text", "text": text}]}})
    out({"type": "result", "subtype": "success", "is_error": False, "session_id": session, "result": "done"})
    '''
).replace("#!PYTHON", "#!" + sys.executable).lstrip()


class ChatTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.bin = root / "bin"
        self.bin.mkdir()
        for kind in ("claude", "codex", "grok", "gemini"):
            path = self.bin / kind
            path.write_text(FAKE_AGENT)
            path.chmod(0o755)
        self.folder = root / "project"
        self.folder.mkdir()
        self.log = root / "calls.log"
        os.environ["FAKE_AGENT_LOG"] = str(self.log)
        os.environ.pop("FAKE_AGENT_MODE", None)
        self.manager = chat.ChatManager(root / "data", lambda kind: str(self.bin / kind))

    def tearDown(self) -> None:
        for room in list(self.manager.rooms.values()):
            self.manager.stop(room.id)
        os.environ.pop("FAKE_AGENT_MODE", None)
        self.tmp.cleanup()

    def calls(self) -> list[dict]:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def wait_idle(self, room: chat.Room, timeout: float = 20) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            meta = room.meta()
            statuses = [message["status"] for message in room.data["messages"]]
            if not meta["busy"] and "running" not in statuses and "queued" not in statuses:
                return
            time.sleep(0.05)
        self.fail(f"room still busy: {[m['status'] for m in room.data['messages']]}")

    def agent_messages(self, room: chat.Room, kind: str) -> list[dict]:
        return [message for message in room.data["messages"] if message["from"] == kind]


class RoomTests(ChatTestCase):
    def test_create_validates(self) -> None:
        with self.assertRaises(chat.ChatError):
            self.manager.create("x", str(self.folder / "missing"), ["claude"], False)
        with self.assertRaises(chat.ChatError):
            self.manager.create("x", str(self.folder), ["nobody"], False)
        room = self.manager.create("", str(self.folder), ["claude", "nobody", "codex"], False)
        self.assertEqual(room.data["members"], ["claude", "codex"])
        self.assertEqual(room.data["name"], "project")

    def test_three_agents_reply_in_order_and_see_each_other(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude", "codex", "grok"], False)
        self.manager.post(room.id, "第一個問題", ["claude", "codex", "grok"])
        self.wait_idle(room)
        senders = [message["from"] for message in room.data["messages"]]
        self.assertEqual(senders, ["user", "claude", "codex", "grok"])
        for kind in ("claude", "codex", "grok"):
            reply = self.agent_messages(room, kind)[0]
            self.assertEqual(reply["status"], "done", reply)
            self.assertTrue(reply["text"])
        self.assertEqual(self.agent_messages(room, "claude")[0]["activity"], ["讀取 README.md"])
        self.assertEqual(self.agent_messages(room, "codex")[0]["activity"], ["執行指令：ls -la"])

        calls = self.calls()
        self.assertEqual([call["kind"] for call in calls], ["claude", "codex", "grok"])
        self.assertTrue(all(call["cwd"] == str(self.folder.resolve()) for call in calls))
        claude_prompt = calls[0]["args"][calls[0]["args"].index("-p") + 1]
        self.assertIn("群組聊天室「demo」", claude_prompt)
        self.assertIn("[使用者]：第一個問題", claude_prompt)
        grok_prompt = calls[2]["args"][calls[2]["args"].index("-p") + 1]
        # Grok runs last and is told what Claude and ChatGPT just said.
        self.assertIn("[Claude]：Claude 看到", grok_prompt)
        self.assertIn("[ChatGPT]：ChatGPT 看到", grok_prompt)
        self.assertIn("--permission-mode", calls[0]["args"])
        self.assertIn("default", calls[0]["args"])
        self.assertIn('sandbox_mode="read-only"', calls[1]["args"])

    def test_second_turn_resumes_sessions_and_sends_only_new_messages(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude", "codex"], True)
        self.manager.post(room.id, "第一個問題", ["claude", "codex"])
        self.wait_idle(room)
        sessions = dict(room.data["sessions"])
        self.assertEqual(set(sessions), {"claude", "codex"})
        self.manager.post(room.id, "第二個問題", ["claude", "codex"])
        self.wait_idle(room)
        calls = self.calls()[2:]
        self.assertEqual(calls[0]["args"][calls[0]["args"].index("--resume") + 1], sessions["claude"])
        self.assertEqual(calls[1]["args"][1:3], ["resume", "--json"])
        self.assertIn(sessions["codex"], calls[1]["args"])
        self.assertIn('sandbox_mode="workspace-write"', calls[1]["args"])
        self.assertIn("acceptEdits", calls[0]["args"])
        second_claude_prompt = calls[0]["args"][calls[0]["args"].index("-p") + 1]
        self.assertNotIn("第一個問題", second_claude_prompt)
        self.assertNotIn("群組聊天室", second_claude_prompt)
        # Claude has not seen ChatGPT's first reply yet, so it gets it now.
        self.assertIn("[ChatGPT]：", second_claude_prompt)
        self.assertIn("[使用者]：第二個問題", second_claude_prompt)

    def test_discuss_runs_every_member(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude", "grok"], False)
        self.manager.post(room.id, "提案", ["claude"])
        self.wait_idle(room)
        self.manager.discuss(room.id, [])
        self.wait_idle(room)
        calls = self.calls()
        self.assertEqual([call["kind"] for call in calls], ["claude", "claude", "grok"])
        self.assertIn("（主持人）", calls[2]["args"][calls[2]["args"].index("-p") + 1])

    def test_login_errors_are_recognised(self) -> None:
        os.environ["FAKE_AGENT_MODE"] = "login"
        room = self.manager.create("demo", str(self.folder), ["grok", "codex"], False)
        self.manager.post(room.id, "hi", ["grok", "codex"])
        self.wait_idle(room, timeout=10)
        for kind in ("grok", "codex"):
            reply = self.agent_messages(room, kind)[0]
            self.assertEqual(reply["status"], "error", reply)
            self.assertEqual(reply["error_kind"], "login", reply)
        self.assertEqual(room.data["sessions"], {})

    def test_missing_tool_is_reported(self) -> None:
        manager = chat.ChatManager(Path(self.tmp.name) / "data2", lambda kind: None)
        room = manager.create("demo", str(self.folder), ["claude"], False)
        manager.post(room.id, "hi", ["claude"])
        self.wait_idle(room)
        reply = self.agent_messages(room, "claude")[0]
        self.assertEqual((reply["status"], reply["error_kind"]), ("error", "missing"))

    def test_stop_cancels_running_and_queued_turns(self) -> None:
        os.environ["FAKE_AGENT_MODE"] = "slow"
        room = self.manager.create("demo", str(self.folder), ["claude", "grok"], False)
        self.manager.post(room.id, "hi", ["claude", "grok"])
        deadline = time.monotonic() + 5
        while room.process is None and time.monotonic() < deadline:
            time.sleep(0.05)
        self.manager.stop(room.id)
        self.wait_idle(room, timeout=10)
        statuses = [message["status"] for message in room.data["messages"][1:]]
        self.assertEqual(statuses, ["cancelled", "cancelled"])

    def test_turn_timeout_stops_a_stuck_tool(self) -> None:
        os.environ["FAKE_AGENT_MODE"] = "slow"
        original = chat.TURN_TIMEOUT_SECONDS
        chat.TURN_TIMEOUT_SECONDS = 1
        try:
            room = self.manager.create("demo", str(self.folder), ["grok"], False)
            self.manager.post(room.id, "hi", ["grok"])
            self.wait_idle(room, timeout=10)
        finally:
            chat.TURN_TIMEOUT_SECONDS = original
        reply = self.agent_messages(room, "grok")[0]
        self.assertEqual(reply["status"], "error")
        self.assertIn("自動停止", reply["error"])

    def test_discuss_refuses_while_busy(self) -> None:
        os.environ["FAKE_AGENT_MODE"] = "slow"
        room = self.manager.create("demo", str(self.folder), ["claude", "grok"], False)
        self.manager.post(room.id, "hi", ["claude"])
        with self.assertRaises(chat.ChatError) as ctx:
            self.manager.discuss(room.id, [])
        self.assertEqual(ctx.exception.code, "busy")
        self.manager.stop(room.id)
        self.wait_idle(room, timeout=10)
        os.environ.pop("FAKE_AGENT_MODE")
        self.manager.discuss(room.id, [])  # idle again: allowed
        self.wait_idle(room)
        self.assertEqual(len([m for m in room.data["messages"] if m["role"] == "discuss"]), 2)

    def test_rooms_persist_and_interrupted_turns_become_errors(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude"], False)
        self.manager.post(room.id, "hi", ["claude"])
        self.wait_idle(room)
        with room.lock:
            room.data["messages"].append(chat._message("claude", status="running"))
        self.manager.save(room)
        reloaded = chat.ChatManager(Path(self.tmp.name) / "data", lambda kind: None)
        data = reloaded.get(room.id).data
        self.assertEqual(data["name"], "demo")
        self.assertEqual(data["messages"][-1]["status"], "error")
        self.manager.delete(room.id)
        self.assertFalse((Path(self.tmp.name) / "data" / "rooms" / f"{room.id}.json").exists())

    def test_changes_since_returns_only_newer_messages(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude"], False)
        self.manager.post(room.id, "hi", ["claude"])
        self.wait_idle(room)
        everything = room.changes_since(0)
        self.assertEqual(len(everything["messages"]), 2)
        self.assertEqual(room.changes_since(everything["rev"])["messages"], [])


class LeaderTests(ChatTestCase):
    def test_leader_assigns_reviews_and_sums_up(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude", "codex", "grok"], False, leader="claude")
        self.manager.post(room.id, "幫我改版網站", ["codex"])  # targets are ignored in leader mode
        self.wait_idle(room)
        flow = [(m["from"], m["role"], m["status"]) for m in room.data["messages"]]
        self.assertEqual(
            flow,
            [
                ("user", "reply", "done"),
                ("claude", "lead", "done"),
                ("codex", "assigned", "done"),
                ("grok", "assigned", "done"),
                ("claude", "review", "done"),
            ],
        )
        self.assertEqual(room.data["messages"][2]["task"], "檢查 index.html 的標題")
        self.assertEqual(room.data["messages"][3]["task"], "查三個競品網站")
        self.assertEqual(room.data["messages"][4]["text"], "總結：大家都完成了")
        calls = self.calls()
        codex_prompt = calls[1]["args"][-1]
        self.assertIn("隊長 Claude 指派給你的任務：檢查 index.html 的標題", codex_prompt)
        review_prompt = calls[3]["args"][calls[3]["args"].index("-p") + 1]
        self.assertIn("[ChatGPT]：ChatGPT 看到", review_prompt)
        self.assertIn("[Grok]：", review_prompt)

    def test_leader_rounds_are_capped(self) -> None:
        os.environ["FAKE_AGENT_MODE"] = "always_assign"
        room = self.manager.create("demo", str(self.folder), ["claude", "codex", "grok"], False, leader="claude")
        self.manager.post(room.id, "go", [])
        self.wait_idle(room, timeout=30)
        leader_turns = [m for m in room.data["messages"] if m["from"] == "claude"]
        self.assertEqual(len(leader_turns), chat.LEADER_ROUNDS)
        self.assertEqual(room.data["messages"][-1]["from"], "system")
        last_prompt = [c for c in self.calls() if c["kind"] == "claude"][-1]["args"]
        self.assertIn("這是最後一輪", last_prompt[last_prompt.index("-p") + 1])

    def test_leader_validation(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude"], False, leader="claude")
        self.assertIsNone(room.data["leader"])  # a leader needs someone to lead
        room = self.manager.create("demo", str(self.folder), ["claude", "grok"], False, leader="codex")
        self.assertIsNone(room.data["leader"])
        self.manager.update(room.id, {"leader": "grok"})
        self.assertEqual(room.data["leader"], "grok")
        self.manager.update(room.id, {"members": ["claude"]})
        self.assertIsNone(room.data["leader"])

    def test_parse_assignments(self) -> None:
        text = (
            "計畫：\n@ChatGPT：寫測試\n2) ＠grok: 查資料\n**@Claude**：自己做\n@Gemini：不是成員\n"
            "```\n@ChatGPT：程式碼裡的不算\n```\n- @codex：改 CSS"
        )
        self.assertEqual(
            chat.parse_assignments(text, ["claude", "codex", "grok"], "claude"),
            [("codex", "寫測試"), ("grok", "查資料"), ("codex", "改 CSS")],
        )


class GeminiTests(ChatTestCase):
    def test_gemini_stream_is_joined_and_resumed(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["gemini", "claude"], True)
        self.manager.post(room.id, "@Gemini 你好", [])
        self.wait_idle(room)
        reply = self.agent_messages(room, "gemini")[0]
        self.assertEqual(reply["status"], "done", reply)
        self.assertEqual(reply["text"], "Gemini 先看一下\n\n看完了")
        self.assertEqual(reply["activity"], ["讀取 notes.md"])
        first = self.calls()[0]["args"]
        self.assertIn("--skip-trust", first)
        self.assertEqual(first[first.index("--approval-mode") + 1], "auto_edit")
        session = first[first.index("--session-id") + 1]
        self.manager.post(room.id, "@gemini 再一次", [])
        self.wait_idle(room)
        second = self.calls()[1]["args"]
        self.assertEqual(second[second.index("--resume") + 1], session)

    def test_gemini_without_login_shows_login_error(self) -> None:
        os.environ["FAKE_AGENT_MODE"] = "login"
        room = self.manager.create("demo", str(self.folder), ["gemini"], False)
        self.manager.post(room.id, "hi", ["gemini"])
        self.wait_idle(room)
        reply = self.agent_messages(room, "gemini")[0]
        self.assertEqual((reply["status"], reply["error_kind"]), ("error", "login"), reply)


class ReplyTests(ChatTestCase):
    def test_reply_goes_to_the_quoted_ai_even_with_a_leader(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude", "codex", "grok"], False)
        self.manager.post(room.id, "大家好", ["claude", "codex"])
        self.wait_idle(room)
        codex_reply = self.agent_messages(room, "codex")[0]
        self.manager.update(room.id, {"leader": "grok"})
        self.manager.post(room.id, "這點我不同意", [], reply_to=codex_reply["id"])
        self.wait_idle(room)
        user_message = room.data["messages"][3]
        self.assertEqual(user_message["reply_to"]["from"], "codex")
        self.assertEqual([m["from"] for m in room.data["messages"][4:]], ["codex"])
        prompt = self.calls()[-1]["args"][-1]
        self.assertIn("[使用者]（回覆你說的「ChatGPT 看到", prompt)
        # Later, Claude sees whom the user was answering.
        self.manager.post(room.id, "Claude 你覺得呢", [], reply_to=self.agent_messages(room, "claude")[0]["id"])
        self.wait_idle(room)
        claude_prompt = self.calls()[-1]["args"]
        text = claude_prompt[claude_prompt.index("-p") + 1]
        self.assertIn("[使用者]（回覆ChatGPT說的「", text)
        self.assertIn("[使用者]（回覆你說的「Claude 看到", text)

    def test_mentions_pick_the_recipients(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude", "codex", "grok"], False, leader="claude")
        self.manager.post(room.id, "＠grok幫我查資料，@ChatGPT 也看一下", ["claude"])
        self.wait_idle(room)
        self.assertEqual([m["from"] for m in room.data["messages"][1:]], ["grok", "codex"])
        self.assertEqual([m["role"] for m in room.data["messages"][1:]], ["reply", "reply"])

    def test_parse_mentions(self) -> None:
        members = ["claude", "codex", "grok"]
        self.assertEqual(chat.parse_mentions("@Claude幫我 @gpt 和 @Grok", members), ["claude", "codex", "grok"])
        self.assertEqual(chat.parse_mentions("寄信到 a@claudex.com", members), [])
        self.assertEqual(chat.parse_mentions("@Grok @grok", ["claude"]), [])

    def test_reply_to_unknown_message_is_rejected(self) -> None:
        room = self.manager.create("demo", str(self.folder), ["claude"], False)
        with self.assertRaises(chat.ChatError):
            self.manager.post(room.id, "hi", [], reply_to="nope")
        user = self.manager.post(room.id, "hi", [])
        with self.assertRaises(chat.ChatError):
            self.manager.post(room.id, "hi", [], reply_to=user["id"])


class ParserTests(unittest.TestCase):
    def test_tool_descriptions(self) -> None:
        self.assertEqual(chat.describe_tool("Edit", {"file_path": "/a/b/index.html"}), "修改 index.html")
        self.assertEqual(chat.describe_tool("Bash", {"command": "npm test"}), "執行指令：npm test")
        self.assertEqual(chat.describe_tool("mystery", {}), "使用工具：mystery")

    def test_ignores_noise(self) -> None:
        parser = chat.TurnParser("claude")
        self.assertFalse(parser.feed("Welcome back!"))
        self.assertFalse(parser.feed("{not json"))
        self.assertFalse(parser.feed('{"type":"rate_limit_event"}'))
        self.assertEqual(parser.text, "")


class ChatHttpTests(ChatTestCase):
    def setUp(self) -> None:
        super().setUp()
        args = herdr_web.parse_args(["--socket", str(Path(self.tmp.name) / "none.sock"), "--herdr-bin", "/nonexistent", "--data-dir", str(Path(self.tmp.name) / "web")])
        self.app = herdr_web.App(args, "pw")
        self.app.chat = self.manager
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), herdr_web.make_handler(self.app))
        self.httpd.daemon_threads = True
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.port = self.httpd.server_address[1]
        status, _, cookie = self.request("POST", "/api/login", {"password": "pw"})
        self.assertEqual(status, 200)
        self.cookie = cookie.split(";", 1)[0]

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def request(self, method: str, path: str, body: dict | None = None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        headers = {"X-Herdr-Web": "1", "Content-Type": "application/json"}
        if getattr(self, "cookie", None):
            headers["Cookie"] = self.cookie
        conn.request(method, path, body=json.dumps(body) if body is not None else None, headers=headers)
        response = conn.getresponse()
        data = json.loads(response.read() or b"{}")
        cookie = response.getheader("Set-Cookie")
        conn.close()
        return response.status, data, cookie

    def test_room_api_round_trip(self) -> None:
        status, data, _ = self.request("POST", "/api/rooms", {"name": "web", "folder": str(self.folder), "members": ["claude", "grok"]})
        self.assertEqual(status, 200)
        room_id = data["room"]["id"]
        status, _, _ = self.request("POST", f"/api/rooms/{room_id}/messages", {"text": "你好", "targets": ["grok"]})
        self.assertEqual(status, 200)
        self.wait_idle(self.manager.get(room_id))
        status, data, _ = self.request("GET", f"/api/rooms/{room_id}?since=0")
        self.assertEqual([m["from"] for m in data["messages"]], ["user", "grok"])
        status, data, _ = self.request("GET", "/api/rooms")
        self.assertEqual(data["rooms"][0]["last"]["from"], "grok")
        status, _, _ = self.request("POST", f"/api/rooms/{room_id}/update", {"allow_edits": True, "name": "改名"})
        self.assertTrue(self.manager.get(room_id).data["allow_edits"])
        status, _, _ = self.request("POST", f"/api/rooms/{room_id}/delete", {})
        self.assertEqual(status, 200)
        status, data, _ = self.request("GET", f"/api/rooms/{room_id}")
        self.assertEqual((status, data["error"]["code"]), (404, "room_not_found"))

    def test_bad_room_requests(self) -> None:
        status, data, _ = self.request("POST", "/api/rooms", {"folder": "/nope", "members": ["claude"]})
        self.assertEqual((status, data["error"]["code"]), (400, "not_a_directory"))
        status, _, _ = self.request("POST", "/api/rooms/zzzz/messages", {"text": "x"})
        self.assertEqual(status, 404)


if __name__ == "__main__":
    unittest.main()
