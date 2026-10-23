"use strict";

/* Group chat rooms: the user and Claude, ChatGPT and Grok working in one
   folder. Relies on helpers from app.js (h, api, toast, openForm, pickFolder,
   confirmAction, AI_TOOLS, state, openPane, offerInstall, toolStatus). */

const TARGETS_KEY = "herdr-web:targets:";
const MENTION_NAMES = { claude: "claude", chatgpt: "codex", codex: "codex", gpt: "codex", grok: "grok" };
const MENTION_PATTERN = /[@＠](claude|chatgpt|codex|gpt|grok)(?![A-Za-z])/gi;

const chat = {
  rooms: [],
  roomId: null,
  room: null,
  order: [],
  messages: new Map(),
  elements: new Map(),
  rev: 0,
  source: null,
  listTimer: null,
  targets: new Set(),
  replyTo: null,
};

/* Who a message will go to, mirroring the server: @-mentions first, then a
   reply's author, then the leader, then the selected chips. */
function mentionedKinds(text, members) {
  const found = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const kind = MENTION_NAMES[match[1].toLowerCase()];
    if (members.includes(kind) && !found.includes(kind)) found.push(kind);
  }
  return found;
}

function routeFor(text) {
  const room = chat.room;
  const mentioned = mentionedKinds(text, room.members);
  const reply = chat.replyTo && room.members.includes(chat.replyTo.from) ? chat.replyTo.from : null;
  if (mentioned.length || reply) {
    // A reply sends no chip targets, so only mentions and the quoted author receive it.
    const kinds = [...mentioned];
    if (reply && !kinds.includes(reply)) kinds.unshift(reply);
    return { kinds, reason: mentioned.length ? "你 @ 了" : "回覆" };
  }
  if (room.leader) return { kinds: [room.leader], reason: "隊長" };
  return { kinds: room.members.filter((kind) => chat.targets.has(kind)), reason: "" };
}

function renderRouteHint() {
  if (!chat.room) return;
  const { kinds, reason } = routeFor($("composer-input").value);
  const names = kinds.map((kind) => chatTool(kind).name).join("、");
  $("route-hint").textContent = names ? `→ 會傳給：${names}${reason ? `（${reason}）` : ""}` : "";
}

function renderReplyBar() {
  const bar = $("reply-bar");
  const reply = chat.replyTo;
  bar.hidden = !reply;
  if (reply) $("reply-text").textContent = `↩ 回覆 ${chatTool(reply.from).name}：${reply.text.replace(/\s+/g, " ").slice(0, 60)}${reply.text.length > 60 ? "…" : ""}`;
}

function startReply(message) {
  chat.replyTo = message;
  renderReplyBar();
  renderComposer();
  $("composer-input").focus();
}

function cancelReply() {
  chat.replyTo = null;
  renderReplyBar();
  renderComposer();
}

function updateMentionSuggest() {
  const input = $("composer-input");
  const box = $("mention-suggest");
  const before = input.value.slice(0, input.selectionStart);
  const match = before.match(/[@＠]([A-Za-z]*)$/);
  box.replaceChildren();
  if (!match || !chat.room) {
    box.hidden = true;
    return;
  }
  const typed = match[1].toLowerCase();
  const options = chat.room.members.filter((kind) => chatTool(kind).name.toLowerCase().startsWith(typed) || kind.startsWith(typed));
  for (const kind of options) {
    const tool = chatTool(kind);
    box.append(
      h(
        "button",
        {
          type: "button",
          class: "chip",
          onclick: () => {
            const start = before.length - match[0].length;
            input.value = `${input.value.slice(0, start)}@${tool.name} ${input.value.slice(input.selectionStart)}`;
            const caret = start + tool.name.length + 2;
            input.setSelectionRange(caret, caret);
            box.hidden = true;
            input.focus();
            renderRouteHint();
          },
        },
        h("span", { class: `ai-logo tiny ${tool.tone}`, text: tool.logo }),
        `@${tool.name}`,
      ),
    );
  }
  box.hidden = options.length === 0;
}

function chatTool(kind) {
  return AI_TOOLS[kind] || { kind, name: kind, logo: (kind[0] || "?").toUpperCase(), tone: "other" };
}

function formatTime(seconds) {
  const date = new Date(seconds * 1000);
  return date.toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit" });
}

/* ---------- rich text (safe: builds DOM nodes, never HTML) ---------- */

function appendInline(parent, text) {
  // `code`, **bold** and bare links; everything else stays plain text.
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|https?:\/\/[^\s<>()]+)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith("`")) parent.append(h("code", { text: token.slice(1, -1) }));
    else if (token.startsWith("**")) parent.append(h("strong", { text: token.slice(2, -2) }));
    else parent.append(h("a", { href: token, target: "_blank", rel: "noopener noreferrer", text: token }));
    last = match.index + token.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function renderRichText(text) {
  const root = h("div", { class: "rich" });
  const parts = text.split(/```[^\n]*\n?/);
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      root.append(h("pre", { class: "code-block" }, h("code", { text: part.replace(/\n$/, "") })));
      return;
    }
    for (const line of part.split("\n")) {
      const heading = line.match(/^#{1,4}\s+(.*)$/);
      if (/^\s*(?:[-*•]\s*|\d+[.)]\s*)?\**[@＠]\s*(claude|chatgpt|codex|gpt|grok)\s*\**\s*[:：]/i.test(line)) {
        const row = h("p", { class: "rich-assign" });
        appendInline(row, line.trim());
        root.append(row);
        continue;
      }
      const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (heading) {
        root.append(h("p", { class: "rich-heading" }, h("strong", { text: heading[1] })));
      } else if (bullet) {
        const row = h("p", { class: "rich-bullet" });
        appendInline(row, line.trim());
        root.append(row);
      } else if (line.trim()) {
        const row = h("p");
        appendInline(row, line);
        root.append(row);
      } else if (root.lastChild && !root.lastChild.classList?.contains("rich-gap")) {
        root.append(h("div", { class: "rich-gap" }));
      }
    }
  });
  return root;
}

/* ---------- room list ---------- */

async function loadRooms() {
  try {
    const data = await api("/api/rooms");
    chat.rooms = data.rooms;
  } catch (err) {
    if (err.status !== 401) toast(err.message, "error");
    return;
  }
  renderRoomList();
}

function renderRoomList() {
  const list = $("room-list");
  list.replaceChildren();
  $("room-list-empty").hidden = chat.rooms.length > 0;
  for (const room of chat.rooms) {
    const last = room.last ? `${room.last.from === "user" ? "你" : chatTool(room.last.from).name}：${room.last.text}` : "還沒有訊息";
    list.append(
      h(
        "li",
        {},
        h(
          "button",
          { type: "button", class: `room-item${room.id === chat.roomId ? " active" : ""}`, onclick: () => openRoom(room.id) },
          h("span", { class: "room-item-top" }, h("strong", { text: room.name }), room.busy ? h("span", { class: "dot working" }) : null),
          h("span", { class: "muted small room-item-last", text: last }),
          h("span", { class: "room-item-members" }, room.members.map((kind) => h("span", { class: `ai-logo tiny ${chatTool(kind).tone}`, text: chatTool(kind).logo }))),
        ),
      ),
    );
  }
}

async function createRoom() {
  if (!state.tools) await loadTools(false);
  const installed = Object.keys(AI_TOOLS).filter((kind) => toolStatus(kind)?.installed);
  if (!installed.length) {
    await inform("還沒有可以用的 AI", "請先到「工作台」安裝 Claude、ChatGPT 或 Grok。");
    return;
  }
  const values = await openForm({
    title: "新聊天室",
    text: "下一步會請你選這個聊天室要用的專案資料夾。",
    fields: [
      { name: "name", label: "聊天室名稱", placeholder: "例如：網站改版（可留空，會用資料夾名稱）" },
      ...installed.map((kind) => ({ name: `m_${kind}`, label: `邀請 ${chatTool(kind).name}`, type: "checkbox", value: true })),
      {
        name: "leader",
        label: "隊長（可選）：讓一個 AI 分派工作給其他 AI",
        type: "select",
        value: "",
        options: [{ value: "", label: "不設隊長，大家一起回答" }, ...installed.map((kind) => ({ value: kind, label: `${chatTool(kind).name} 當隊長` }))],
      },
      { name: "allow_edits", label: "允許 AI 修改資料夾裡的檔案（之後可以再改）", type: "checkbox", value: false },
    ],
    okText: "下一步：選資料夾",
  });
  if (!values) return;
  const members = installed.filter((kind) => values[`m_${kind}`]);
  if (!members.length) {
    toast("至少要邀請一個 AI", "error");
    return;
  }
  if (values.leader && (!members.includes(values.leader) || members.length < 2)) {
    toast("隊長要是被邀請的成員，而且至少要有兩個 AI", "error");
    return;
  }
  const folder = await pickFolder("聊天室要用哪個資料夾？");
  if (!folder) return;
  try {
    const result = await api("/api/rooms", { method: "POST", body: { name: values.name, folder, members, allow_edits: values.allow_edits, leader: values.leader || null } });
    await loadRooms();
    openRoom(result.room.id);
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ---------- one room ---------- */

function closeRoomStream() {
  if (chat.source) {
    chat.source.close();
    chat.source = null;
  }
}

async function openRoom(roomId) {
  closeRoomStream();
  chat.roomId = roomId;
  chat.room = null;
  chat.order = [];
  chat.messages.clear();
  chat.elements.clear();
  chat.rev = 0;
  chat.replyTo = null;
  renderReplyBar();
  $("messages").replaceChildren();
  $("room-empty").hidden = true;
  $("room-main").hidden = false;
  $("room-settings").hidden = true;
  $("chat-view").classList.add("room-open");
  renderRoomList();
  try {
    applyRoomChanges(await api(`/api/rooms/${roomId}?since=0`));
  } catch (err) {
    toast(err.message, "error");
    return;
  }
  connectRoom();
  scrollMessages(true);
  $("composer-input").focus();
}

function closeRoom() {
  closeRoomStream();
  chat.roomId = null;
  $("room-main").hidden = true;
  $("room-empty").hidden = false;
  $("chat-view").classList.remove("room-open");
  renderRoomList();
}

function connectRoom() {
  closeRoomStream();
  const roomId = chat.roomId;
  const source = new EventSource(`/api/rooms/${roomId}/events?since=${chat.rev}`);
  chat.source = source;
  source.addEventListener("room", (event) => {
    if (chat.roomId !== roomId) return;
    try {
      applyRoomChanges(JSON.parse(event.data));
    } catch (err) {
      console.error("bad room event", err);
    }
  });
  source.addEventListener("error", () => {
    if (source.readyState === EventSource.CLOSED && chat.source === source) {
      setTimeout(() => {
        if (chat.source === source && chat.roomId === roomId) connectRoom();
      }, 3000);
    }
  });
}

function applyRoomChanges(changes) {
  const nearBottom = isNearBottom();
  let finished = false;
  chat.room = changes.room;
  chat.rev = changes.rev;
  for (const message of changes.messages) {
    const previous = chat.messages.get(message.id);
    if (!previous) chat.order.push(message.id);
    chat.messages.set(message.id, message);
    renderMessage(message);
    if (previous && previous.status === "running" && message.status !== "running" && message.from !== "user") {
      if (message.status === "done") notifyReply(message);
      finished = true;
    }
  }
  renderRoomHeader();
  renderComposer();
  scrollMessages(nearBottom);
  if (finished) loadRooms();
}

function renderRoomHeader() {
  const room = chat.room;
  if (!room) return;
  $("room-name").textContent = room.name;
  $("room-folder").textContent = `📁 ${room.folder}`;
  const members = $("room-members");
  members.replaceChildren();
  for (const kind of room.members) {
    const tool = chatTool(kind);
    const lead = room.leader === kind;
    members.append(h("span", { class: `member${lead ? " leader" : ""}`, title: lead ? `${tool.name}（隊長）` : tool.name }, lead ? "👑" : null, h("span", { class: `ai-logo tiny ${tool.tone}`, text: tool.logo })));
  }
  $("room-allow-edits").checked = room.allow_edits;
  const select = $("room-leader");
  select.replaceChildren(
    h("option", { value: "", text: "不設隊長", selected: !room.leader }),
    ...room.members.map((kind) => h("option", { value: kind, text: chatTool(kind).name, selected: room.leader === kind })),
  );
  select.disabled = room.members.length < 2;
}

function loadTargets(room) {
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(TARGETS_KEY + room.id) || "null");
  } catch (err) {
    saved = null;
  }
  const wanted = Array.isArray(saved) ? saved.filter((kind) => room.members.includes(kind)) : [];
  return new Set(wanted.length ? wanted : room.members);
}

function saveTargets() {
  try {
    localStorage.setItem(TARGETS_KEY + chat.room.id, JSON.stringify([...chat.targets]));
  } catch (err) {
    /* not remembered in private mode */
  }
}

function renderComposer() {
  const room = chat.room;
  if (!room) return;
  if (!chat.targets.size || chat.targetsRoom !== room.id) {
    chat.targets = loadTargets(room);
    chat.targetsRoom = room.id;
  }
  const chips = $("target-chips");
  chips.replaceChildren();
  const leader = chat.replyTo ? null : room.leader;
  $("composer-targets-label").textContent = leader || chat.replyTo ? "" : "傳給：";
  if (leader) {
    chips.append(h("span", { class: "leader-hint" }, `👑 訊息會交給隊長 ${chatTool(leader).name}，由它分派工作給其他成員，最後向你總結。`));
  }
  for (const kind of leader || chat.replyTo ? [] : room.members) {
    const tool = chatTool(kind);
    const on = chat.targets.has(kind);
    chips.append(
      h(
        "button",
        {
          type: "button",
          class: `chip target ${tool.tone}${on ? " active" : ""}`,
          "aria-pressed": on ? "true" : "false",
          onclick: () => {
            if (chat.targets.has(kind) && chat.targets.size > 1) chat.targets.delete(kind);
            else chat.targets.add(kind);
            saveTargets();
            renderComposer();
          },
        },
        h("span", { class: `ai-logo tiny ${tool.tone}`, text: tool.logo }),
        tool.name,
      ),
    );
  }
  const busy = room.busy;
  $("stop-btn").hidden = !busy;
  $("discuss-btn").disabled = busy || room.members.length < 2;
  const running = [...chat.messages.values()].find((message) => message.status === "running");
  $("room-busy").textContent = running
    ? `${chatTool(running.from).name} 正在回覆…${room.queued.length ? `（之後還有 ${room.queued.map((kind) => chatTool(kind).name).join("、")}）` : ""}`
    : "";
  renderRouteHint();
}

function renderMessage(message) {
  const old = chat.elements.get(message.id);
  const element =
    message.from === "user" ? userBubble(message) : message.from === "system" ? h("div", { class: "msg system", text: message.text }) : agentBubble(message);
  chat.elements.set(message.id, element);
  if (old) old.replaceWith(element);
  else $("messages").append(element);
}

function userBubble(message) {
  const quoted = message.reply_to;
  const quote = quoted
    ? h(
        "button",
        {
          type: "button",
          class: "quote",
          title: "跳到原本的訊息",
          onclick: () => chat.elements.get(quoted.id)?.scrollIntoView({ behavior: "smooth", block: "center" }),
        },
        `↩ ${chatTool(quoted.from).name}：${quoted.excerpt.slice(0, 80)}${quoted.excerpt.length > 80 ? "…" : ""}`,
      )
    : null;
  return h(
    "div",
    { class: "msg user" },
    quote,
    h("div", { class: "bubble" }, renderRichText(message.text)),
    h("span", { class: "msg-time muted small", text: formatTime(message.at) }),
  );
}

function agentBubble(message) {
  const tool = chatTool(message.from);
  const body = h("div", { class: "bubble" });
  if (message.text) body.append(renderRichText(message.text));
  if (message.status === "queued") body.append(h("p", { class: "muted small", text: "排隊中，等前面的 AI 回覆完…" }));
  if (message.status === "running" && !message.text) body.append(h("p", { class: "typing", "aria-label": "正在思考" }, h("span"), h("span"), h("span")));
  if (message.status === "cancelled") body.append(h("p", { class: "muted small", text: "已停止" }));
  if (message.status === "error") body.append(errorBox(message, tool));

  const activity = message.activity || [];
  let steps = null;
  if (activity.length) {
    const latest = activity[activity.length - 1];
    steps = h(
      "details",
      { class: "activity" },
      h("summary", { text: message.status === "running" ? `⏳ ${latest}` : `做了 ${activity.length} 個步驟` }),
      h("ul", {}, activity.map((step) => h("li", { text: step }))),
    );
  }
  const leaderName = chat.room?.leader ? chatTool(chat.room.leader).name : "隊長";
  let role = null;
  if (message.role === "assigned" && message.task) role = h("p", { class: "msg-role" }, `📋 ${leaderName} 指派：`, message.task);
  else if (message.role === "review") role = h("p", { class: "msg-role" }, "🧭 檢查大家的成果，決定下一步");
  else if (message.role === "lead") role = h("p", { class: "msg-role" }, "👑 隊長規劃分工");
  return h(
    "div",
    { class: `msg agent ${message.status}` },
    h("span", { class: `ai-logo small ${tool.tone}`, text: tool.logo, "aria-hidden": "true" }),
    h(
      "div",
      { class: "msg-col" },
      h(
        "span",
        { class: "msg-name" },
        tool.name,
        h("span", { class: "msg-time muted small", text: formatTime(message.at) }),
        message.status === "done" && message.text
          ? h("button", { type: "button", class: "reply-btn", text: "↩ 回覆", title: `回覆 ${tool.name} 這段話`, onclick: () => startReply(message) })
          : null,
      ),
      role,
      steps,
      body,
    ),
  );
}

function errorBox(message, tool) {
  const box = h("div", { class: "msg-error" });
  if (message.error_kind === "login") {
    box.append(
      h("p", { text: `${tool.name} 還沒登入（或登入過期了）。按下面的按鈕，在打開的視窗裡完成登入，再回來重新傳一次訊息。` }),
      h("button", { type: "button", class: "small primary", text: `登入 ${tool.name}`, onclick: () => startLogin(message.from) }),
    );
  } else if (message.error_kind === "missing") {
    box.append(
      h("p", { text: message.error }),
      h("button", { type: "button", class: "small", text: `安裝 ${tool.name}`, onclick: () => offerInstall(message.from, tool, toolStatus(message.from)) }),
    );
  } else {
    box.append(h("p", { text: `出錯了：${message.error || "未知的錯誤"}` }));
  }
  return box;
}

async function startLogin(kind) {
  const status = toolStatus(kind);
  const tool = chatTool(kind);
  const command = status?.login || tool.command;
  const folder = chat.room?.folder;
  const result = await run(() => call("workspace.create", { label: `登入 ${tool.name}`, cwd: folder || undefined, focus: false }));
  const paneId = result?.root_pane?.pane_id;
  if (!paneId) return;
  openPane(paneId);
  await sleep(900);
  await run(() => call("pane.send_text", { pane_id: paneId, text: command }));
  await run(() => call("pane.send_keys", { pane_id: paneId, keys: ["enter"] }));
  toast("登入完成後按「← 返回」，再回到聊天室傳訊息");
}

function notifyReply(message) {
  if (!document.hidden) return;
  const body = `${chatTool(message.from).name}：${message.text.slice(0, 120)}`;
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(chat.room?.name || "herdr", { body, tag: message.id });
    } catch (err) {
      /* ignore */
    }
  }
}

function isNearBottom() {
  const box = $("messages");
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

function scrollMessages(force) {
  if (!force) return;
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

/* ---------- actions ---------- */

async function sendChat(event) {
  event?.preventDefault();
  const input = $("composer-input");
  const text = input.value.trim();
  if (!text || !chat.room) return;
  const targets = chat.replyTo ? [] : chat.room.members.filter((kind) => chat.targets.has(kind));
  $("composer-send").disabled = true;
  try {
    await api(`/api/rooms/${chat.room.id}/messages`, { method: "POST", body: { text, targets, reply_to: chat.replyTo?.id || null } });
    input.value = "";
    $("mention-suggest").hidden = true;
    cancelReply();
    scrollMessages(true);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    $("composer-send").disabled = false;
    input.focus();
  }
}

async function discuss() {
  if (!chat.room) return;
  const targets = chat.room.members.filter((kind) => chat.targets.has(kind));
  await run(() => api(`/api/rooms/${chat.room.id}/discuss`, { method: "POST", body: { targets: targets.length > 1 ? targets : chat.room.members } }));
  scrollMessages(true);
}

async function stopRoom() {
  if (!chat.room) return;
  await run(() => api(`/api/rooms/${chat.room.id}/stop`, { method: "POST", body: {} }), "已停止");
}

async function setAllowEdits(event) {
  if (!chat.room) return;
  const allow = event.target.checked;
  if (allow && !(await confirmAction("允許 AI 修改檔案？", `Claude、ChatGPT、Grok 之後可以直接修改「${chat.room.folder}」裡的檔案。建議先備份重要檔案。`, "允許", false))) {
    event.target.checked = false;
    return;
  }
  await run(() => api(`/api/rooms/${chat.room.id}/update`, { method: "POST", body: { allow_edits: allow } }), allow ? "已允許修改檔案" : "已改成只能讀取");
}

async function renameRoom() {
  if (!chat.room) return;
  const values = await openForm({ title: "重新命名聊天室", fields: [{ name: "name", label: "新名稱", value: chat.room.name, required: true }] });
  if (!values?.name) return;
  await run(() => api(`/api/rooms/${chat.room.id}/update`, { method: "POST", body: { name: values.name } }));
  loadRooms();
}

async function deleteRoom() {
  if (!chat.room) return;
  if (!(await confirmAction("刪除聊天室？", `「${chat.room.name}」的對話紀錄會被刪除。資料夾裡的檔案不會受影響。`, "刪除"))) return;
  const ok = await run(() => api(`/api/rooms/${chat.room.id}/delete`, { method: "POST", body: {} }).then(() => true));
  if (!ok) return;
  closeRoom();
  loadRooms();
}

async function openRoomFolder() {
  if (!chat.room) return;
  await run(() => api("/api/open-folder", { method: "POST", body: { path: chat.room.folder } }));
}

/* ---------- wiring ---------- */

function chatShow() {
  loadRooms();
  clearInterval(chat.listTimer);
  chat.listTimer = setInterval(() => {
    if (state.view === "chat" && !document.hidden) loadRooms();
  }, 5000);
}

function bindChat() {
  $("new-room-btn").addEventListener("click", createRoom);
  $("room-back-btn").addEventListener("click", closeRoom);
  $("composer-form").addEventListener("submit", sendChat);
  $("composer-input").addEventListener("keydown", (event) => {
    // Enter sends; Shift+Enter adds a line; never send while an IME is composing.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) sendChat(event);
  });
  $("discuss-btn").addEventListener("click", discuss);
  $("reply-cancel").addEventListener("click", cancelReply);
  $("composer-input").addEventListener("input", () => {
    updateMentionSuggest();
    renderRouteHint();
  });
  $("stop-btn").addEventListener("click", stopRoom);
  $("room-menu-btn").addEventListener("click", () => {
    $("room-settings").hidden = !$("room-settings").hidden;
  });
  $("room-allow-edits").addEventListener("change", setAllowEdits);
  $("room-leader").addEventListener("change", (event) => {
    if (!chat.room) return;
    const leader = event.target.value || null;
    run(() => api(`/api/rooms/${chat.room.id}/update`, { method: "POST", body: { leader } }), leader ? `${chatTool(leader).name} 現在是隊長` : "已取消隊長");
  });
  $("room-rename-btn").addEventListener("click", renameRoom);
  $("room-open-folder-btn").addEventListener("click", openRoomFolder);
  $("room-folder").addEventListener("click", openRoomFolder);
  $("room-delete-btn").addEventListener("click", deleteRoom);
}

bindChat();
