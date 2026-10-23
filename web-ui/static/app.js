"use strict";

/* Plain-language labels: the home screen never shows herdr's internal terms. */
const STATUS_LABELS = {
  working: "正在工作…",
  blocked: "等你回答問題",
  done: "做完了，有新結果",
  idle: "準備好了，等你下指令",
  unknown: "終端機",
};
const STATUS_ORDER = ["blocked", "working", "done", "idle"];
const STATUS_RANK = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };

/* The AI tools on the home screen, keyed by herdr agent kind. */
const AI_TOOLS = {
  claude: { kind: "claude", name: "Claude", product: "Claude Code", account: "Claude 帳號", command: "claude", logo: "C", tone: "claude" },
  codex: { kind: "codex", name: "ChatGPT", product: "Codex", account: "ChatGPT 帳號", command: "codex", logo: "G", tone: "chatgpt" },
  grok: { kind: "grok", name: "Grok", product: "Grok Build", account: "Grok 帳號", command: "grok", logo: "X", tone: "grok" },
  agy: { kind: "agy", name: "Gemini", product: "Antigravity CLI", account: "Google 帳號", command: "agy", logo: "✦", tone: "gemini" },
};

/* Names for the agent picker in the advanced view. */
const AGENT_LABELS = {
  claude: "Claude（Claude Code）",
  codex: "ChatGPT（Codex）",
  grok: "Grok（Grok Build）",
  agy: "Gemini（Antigravity CLI）",
  gemini: "Gemini CLI（舊版）",
  copilot: "GitHub Copilot CLI",
  cursor: "Cursor Agent CLI",
  opencode: "OpenCode",
};

const OUTPUT_POLL_MS = 1500;
const OUTPUT_LINES = 400;
const LAST_FOLDER_KEY = "herdr-web:last-folder";

const state = {
  online: false,
  error: null,
  snapshot: null,
  meta: { agent_kinds: [], preferred_agents: [] },
  tools: null,
  view: "chat",
  openPaneId: null,
  openPaneSeen: false,
  lastStatuses: new Map(),
  events: null,
  outputTimer: null,
  outputInFlight: false,
  configLoaded: false,
  configDirty: false,
  folder: null,
};

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- DOM helpers ---------- */

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "dataset") Object.assign(el.dataset, value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

function toast(message, kind = "info") {
  const el = h("div", { class: `toast ${kind}`, text: message });
  $("toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 6000 : 3500);
}

function basename(path) {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed || "/";
}

function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch (err) {
    /* private mode: just don't remember */
  }
}

/* ---------- API ---------- */

class ApiError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function api(path, { method = "GET", body } = {}) {
  const options = { method, credentials: "same-origin", headers: { "X-Herdr-Web": "1" } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch (err) {
    throw new ApiError("network", "連不到 herdr 控制台。請確認 Herdr Web 有在執行。", 0);
  }
  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }
  if (!response.ok) {
    const error = data.error || {};
    if (response.status === 401 && path !== "/api/login") showLogin();
    throw new ApiError(error.code || "http_error", error.message || `HTTP ${response.status}`, response.status);
  }
  return data;
}

async function call(method, params = {}) {
  const data = await api("/api/call", { method: "POST", body: { method, params } });
  return data.result;
}

async function run(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) toast(successMessage);
    return result;
  } catch (err) {
    toast(err.message || String(err), "error");
    return undefined;
  }
}

/* ---------- dialogs ---------- */

function openForm({ title, text = "", fields = [], okText = "確定", cancelText = "取消", danger = false }) {
  const dialog = $("form-dialog");
  // A second open (for example a double click) would tangle two prompts together.
  if (dialog.open) return Promise.resolve(null);
  const container = $("form-dialog-fields");
  $("form-dialog-title").textContent = title;
  $("form-dialog-text").textContent = text;
  $("form-dialog-text").hidden = !text;
  const ok = $("form-dialog-ok");
  ok.textContent = okText;
  ok.className = danger ? "danger" : "primary";
  const cancel = $("form-dialog-cancel");
  cancel.textContent = cancelText || "";
  cancel.hidden = !cancelText;
  container.replaceChildren();
  const inputs = {};
  for (const field of fields) {
    const id = `field-${field.name}`;
    if (field.type === "checkbox") {
      // Checkboxes sit inside their label instead of below it.
      const box = h("input", { id, name: field.name, type: "checkbox", checked: Boolean(field.value), disabled: field.disabled || false });
      container.append(h("label", { class: "check field-check", for: id }, box, field.label));
      inputs[field.name] = box;
      continue;
    }
    container.append(h("label", { for: id, text: field.label }));
    let input;
    if (field.type === "select") {
      input = h("select", { id, name: field.name });
      const groups = new Map();
      for (const opt of field.options) {
        const option = h("option", { value: opt.value, text: opt.label, selected: opt.value === field.value });
        if (!opt.group) {
          input.append(option);
          continue;
        }
        if (!groups.has(opt.group)) {
          groups.set(opt.group, h("optgroup", { label: opt.group }));
          input.append(groups.get(opt.group));
        }
        groups.get(opt.group).append(option);
      }
    } else {
      input = h("input", {
        id,
        name: field.name,
        type: field.type || "text",
        value: field.value ?? "",
        placeholder: field.placeholder || "",
        required: field.required || false,
        autocomplete: "off",
        autocapitalize: "off",
      });
    }
    inputs[field.name] = input;
    container.append(input);
  }
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      if (dialog.returnValue !== "ok") return resolve(null);
      const values = {};
      for (const [name, input] of Object.entries(inputs)) values[name] = input.type === "checkbox" ? input.checked : input.value.trim();
      resolve(values);
    };
    dialog.addEventListener("close", onClose);
    dialog.returnValue = "";
    dialog.showModal();
    const first = Object.values(inputs)[0];
    // With no fields, a safe confirmation defaults to its main button and a
    // dangerous one (close, delete) to cancel.
    if (first) first.focus();
    else if (!danger) ok.focus();
  });
}

async function confirmAction(title, text, okText, danger = true) {
  return (await openForm({ title, text, okText, danger })) !== null;
}

async function inform(title, text) {
  await openForm({ title, text, okText: "知道了", cancelText: "" });
}

/* ---------- folder picker ---------- */

function recentFolders() {
  const seen = new Set();
  const folders = [];
  for (const pane of state.snapshot?.panes || []) {
    const cwd = pane.foreground_cwd || pane.cwd;
    if (cwd && !seen.has(cwd)) {
      seen.add(cwd);
      folders.push(cwd);
    }
  }
  return folders.slice(0, 4);
}

async function showFolder(path) {
  $("folder-error").textContent = "";
  let data;
  try {
    data = await api(`/api/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`);
  } catch (err) {
    // A remembered folder may have been moved or deleted: start from home instead.
    if (path && !state.folder) return showFolder(null);
    $("folder-error").textContent = folderErrorText(err, path);
    return;
  }
  $("folder-ok").disabled = false;
  state.folder = data;
  $("folder-path").textContent = data.path;
  $("folder-up-btn").disabled = !data.parent;
  $("folder-ok").textContent = `在「${data.name}」開始`;

  const shortcuts = $("folder-shortcuts");
  shortcuts.replaceChildren();
  const chips = [...data.shortcuts];
  for (const folder of recentFolders()) {
    if (!chips.some((chip) => chip.path === folder)) chips.push({ label: `最近：${basename(folder)}`, path: folder });
  }
  for (const chip of chips) {
    shortcuts.append(
      h("button", {
        type: "button",
        class: `chip${chip.path === data.path ? " active" : ""}`,
        text: chip.label,
        title: chip.path,
        onclick: () => showFolder(chip.path),
      }),
    );
  }

  const list = $("folder-list");
  list.replaceChildren();
  if (!data.entries.length) list.append(h("li", { class: "muted folder-empty", text: "這裡沒有其他資料夾" }));
  for (const name of data.entries) {
    list.append(
      h(
        "li",
        {},
        h("button", { type: "button", class: "folder-item", onclick: () => showFolder(`${data.path.replace(/\/$/, "")}/${name}`) }, h("span", { class: "folder-icon", text: "📁" }), name),
      ),
    );
  }
  list.scrollTop = 0;
}

function folderErrorText(err, path) {
  if (err.code === "permission_denied") {
    return `macOS 保護了「${basename(path) || "這個資料夾"}」，herdr 沒有權限讀取（「桌面」「文件」「下載」和雲端硬碟都會這樣）。` +
      "請回到「主資料夾」，按「＋ 新增資料夾」建一個專案資料夾來用。";
  }
  return `打不開這個資料夾：${err.message}`;
}

async function createFolder() {
  const parent = state.folder?.path;
  if (!parent) return;
  const values = await openForm({
    title: "新增資料夾",
    text: `會建立在「${state.folder.name}」裡面。`,
    fields: [{ name: "name", label: "資料夾名稱", value: "AI 專案", required: true }],
    okText: "建立",
  });
  if (!values || !values.name) return;
  try {
    const data = await api("/api/dirs/create", { method: "POST", body: { parent, name: values.name } });
    await showFolder(data.path);
  } catch (err) {
    $("folder-error").textContent =
      err.code === "invalid_name" ? "名稱不能是空的、不能用 . 開頭，也不能有 /。" : folderErrorText(err, parent);
  }
}

function pickFolder(title) {
  const dialog = $("folder-dialog");
  $("folder-title").textContent = title;
  state.folder = null;
  $("folder-ok").disabled = true;
  $("folder-path").textContent = "讀取中…";
  showFolder(storageGet(LAST_FOLDER_KEY));
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      if (dialog.returnValue !== "ok" || !state.folder) return resolve(null);
      storageSet(LAST_FOLDER_KEY, state.folder.path);
      resolve(state.folder.path);
    };
    dialog.addEventListener("close", onClose);
    dialog.returnValue = "";
    dialog.showModal();
  });
}

/* ---------- snapshot helpers ---------- */

function agentForPane(paneId) {
  return (state.snapshot?.agents || []).find((agent) => agent.pane_id === paneId) || null;
}

function paneById(paneId) {
  return (state.snapshot?.panes || []).find((pane) => pane.pane_id === paneId) || null;
}

/* Agents that are not offered on the home screen but may still be running. */
const OTHER_TOOLS = {
  gemini: { kind: "gemini", name: "Gemini（舊版）", product: "Gemini CLI", logo: "✦", tone: "gemini" },
};

function toolForPane(pane) {
  return AI_TOOLS[pane.agent] || OTHER_TOOLS[pane.agent] || null;
}

function paneName(pane) {
  const tool = toolForPane(pane);
  if (pane.label) return pane.label;
  if (tool) return tool.name;
  const agent = agentForPane(pane.pane_id);
  return agent?.name || pane.display_agent || pane.terminal_title_stripped || pane.title || "終端機";
}

function paneFolder(pane) {
  return pane.foreground_cwd || pane.cwd || "";
}

function paneMeta(pane) {
  const parts = [];
  if (pane.display_agent || pane.agent) parts.push(pane.display_agent || pane.agent);
  const cwd = paneFolder(pane);
  if (cwd) parts.push(cwd);
  parts.push(pane.pane_id);
  return parts.join(" · ");
}

function statusLabel(pane) {
  if (pane.agent_status === "unknown") return pane.agent ? "偵測中" : STATUS_LABELS.unknown;
  return STATUS_LABELS[pane.agent_status] || STATUS_LABELS.idle;
}

function statusBadge(pane) {
  const value = STATUS_LABELS[pane.agent_status] ? pane.agent_status : "unknown";
  return h("span", { class: `status ${value}`, text: statusLabel(pane) });
}

function orderedPanes(tabId) {
  const snapshot = state.snapshot;
  const panes = snapshot.panes.filter((pane) => pane.tab_id === tabId);
  const layout = (snapshot.layouts || []).find((item) => item.tab_id === tabId);
  if (!layout) return panes;
  const order = new Map(layout.panes.map((item, index) => [item.pane_id, index]));
  return panes.sort((a, b) => (order.get(a.pane_id) ?? 99) - (order.get(b.pane_id) ?? 99));
}

function agentOptions() {
  const preferred = new Set(state.meta.preferred_agents || []);
  return (state.meta.agent_kinds || []).map((kind) => ({
    value: kind,
    label: AGENT_LABELS[kind] || kind,
    group: preferred.size ? (preferred.has(kind) ? "你的訂閱" : "其他") : undefined,
  }));
}

/* ---------- home: AI cards ---------- */

function toolStatus(kind) {
  return state.tools?.agents.find((agent) => agent.kind === kind) || null;
}

function renderAiCards() {
  const grid = $("ai-grid");
  grid.replaceChildren();
  const kinds = state.meta.preferred_agents?.length ? state.meta.preferred_agents : Object.keys(AI_TOOLS);
  for (const kind of kinds) {
    const tool = AI_TOOLS[kind] || { name: kind, product: kind, logo: kind[0]?.toUpperCase() || "?", tone: "other" };
    const status = toolStatus(kind);
    let line;
    let lineClass = "muted";
    if (!state.tools) line = "檢查中…";
    else if (status?.installed) {
      line = "可以開始";
      lineClass = "ok";
    } else if (status?.install) {
      line = "還沒安裝・點這裡安裝";
      lineClass = "warn";
    } else {
      line = "還沒安裝";
      lineClass = "warn";
    }
    grid.append(
      h(
        "button",
        { type: "button", class: `ai-card ${tool.tone}`, onclick: () => onAiCard(kind), disabled: !state.online },
        h("span", { class: `ai-logo ${tool.tone}`, text: tool.logo, "aria-hidden": "true" }),
        h("span", { class: "ai-text" }, h("strong", { text: tool.name }), h("span", { class: "muted small", text: tool.product }), h("span", { class: `ai-line ${lineClass}`, text: line })),
      ),
    );
  }
}

async function loadTools(refresh = false) {
  try {
    state.tools = await api(`/api/agents${refresh ? "?refresh=1" : ""}`);
  } catch (err) {
    state.tools = null;
    if (err.status !== 401) toast(err.message, "error");
  }
  renderAiCards();
  renderToolList();
}

async function onAiCard(kind) {
  const tool = AI_TOOLS[kind] || { name: kind, product: kind, account: "帳號", command: kind };
  const status = toolStatus(kind);
  if (!state.tools) return;
  if (!status?.installed) return offerInstall(kind, tool, status);
  const folder = await pickFolder(`要讓 ${tool.name} 在哪個資料夾工作？`);
  if (!folder) return;
  await startSession(tool, folder);
}

/* Claude, ChatGPT and Grok are started by typing their command, so a first-run
   login or setup screen still shows up. Other herdr agents go through
   agent.start, which knows each one's executable. */
async function launchInPane(paneId, kind) {
  const tool = AI_TOOLS[kind];
  if (tool) {
    await call("pane.send_text", { pane_id: paneId, text: tool.command });
    await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  } else {
    await call("agent.start", { pane_id: paneId, kind, name: AGENT_LABELS[kind] || kind, timeout_ms: 30000 });
  }
}

async function startSession(tool, folder) {
  try {
    const result = await call("workspace.create", { label: `${tool.name} · ${basename(folder)}`, cwd: folder, focus: false });
    const paneId = result?.root_pane?.pane_id;
    if (!paneId) throw new Error("herdr 沒有回傳新的視窗");
    openPane(paneId);
    $("pane-output").textContent = `正在啟動 ${tool.name}…`;
    // Give the new shell a moment to show its prompt before typing the command.
    await sleep(900);
    await launchInPane(paneId, tool.kind);
    setTimeout(() => refreshOutput(true), 800);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function offerInstall(kind, tool, status) {
  if (!status?.install) {
    await inform(`${tool.name} 還沒安裝`, `${tool.product} 需要先安裝。裝好之後回到這裡按「重新檢查」。`);
    return;
  }
  const ok = await confirmAction(
    `安裝 ${tool.product}？`,
    `會從官方來源下載安裝，並打開一個視窗顯示進度，大約一兩分鐘。裝好後第一次使用時，畫面會引導你登入${tool.account}（和桌面版同一個帳號）。`,
    "安裝",
    false,
  );
  if (!ok) return;
  toast(`正在打開 ${tool.product} 的安裝視窗…`);
  try {
    if (!state.online) throw new Error("herdr 還沒啟動，請先按上方的「啟動 herdr」再試一次。");
    const home = (await api("/api/dirs"))?.shortcuts?.[0]?.path;
    const result = await call("workspace.create", { label: `安裝 ${tool.name}`, cwd: home || undefined, focus: false });
    const paneId = result?.root_pane?.pane_id;
    if (!paneId) throw new Error("herdr 沒有開出新的視窗。");
    openPane(paneId);
    await sleep(900);
    await call("pane.send_text", { pane_id: paneId, text: status.install });
    await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
    toast("安裝完成後，按「← 返回」再按「重新檢查」");
  } catch (err) {
    await inform(`沒辦法開始安裝 ${tool.product}`, `${err.message || err}。截圖給協助你的人看，或稍後再試一次。`);
  }
}

/* ---------- home: sessions ---------- */

function renderSessions() {
  const root = $("sessions");
  root.replaceChildren();
  const all = state.snapshot?.panes || [];
  // The home screen lists AI conversations; plain terminals live in the advanced view.
  const panes = all.filter((pane) => pane.agent).sort(
    (a, b) => (STATUS_RANK[a.agent_status] ?? 9) - (STATUS_RANK[b.agent_status] ?? 9),
  );
  const shells = all.length - panes.length;
  $("sessions-empty").hidden = !state.online || panes.length > 0;
  $("sessions-shells").hidden = shells === 0;
  $("sessions-shells").textContent = `另外還有 ${shells} 個一般終端機視窗，在下方「進階檢視」裡。`;
  for (const pane of panes) {
    const tool = toolForPane(pane);
    root.append(
      h(
        "div",
        { class: "session-row" },
        h(
          "button",
          { type: "button", class: `session-card ${pane.agent_status}`, onclick: () => openPane(pane.pane_id) },
          h("span", { class: `ai-logo small ${tool ? tool.tone : "shell"}`, text: tool ? tool.logo : ">_", "aria-hidden": "true" }),
          h("span", { class: "session-main" }, h("strong", { text: paneName(pane) }), h("span", { class: "muted small", text: `📁 ${basename(paneFolder(pane))}` })),
          h("span", { class: "session-status" }, h("span", { class: `dot ${pane.agent_status}` }), statusBadge(pane)),
        ),
        h("button", { type: "button", class: "icon ghost danger session-close", title: "結束這個對話", "aria-label": `結束「${paneName(pane)}」`, text: "✕", onclick: () => endPane(pane) }),
      ),
    );
  }
}

function renderConnection() {
  const pill = $("conn-pill");
  if (state.online) {
    pill.textContent = "已連線";
    pill.title = `herdr ${state.snapshot?.version || ""}`;
    pill.className = "pill online";
  } else {
    pill.textContent = "未連線";
    pill.className = "pill offline";
  }
  $("offline-banner").hidden = state.online;
  $("offline-detail").textContent = state.error || "";
}

function renderSummary() {
  const summary = $("summary");
  summary.replaceChildren();
  const panes = state.snapshot?.panes || [];
  const counts = {};
  for (const pane of panes) if (pane.agent) counts[pane.agent_status] = (counts[pane.agent_status] || 0) + 1;
  for (const status of STATUS_ORDER) {
    if (!counts[status]) continue;
    summary.append(h("span", { class: "chip static" }, h("span", { class: `dot ${status}` }), `${STATUS_LABELS[status]} ${counts[status]}`));
  }
  if (counts.done) {
    summary.append(h("button", { type: "button", class: "chip", onclick: markAllSeen, title: "把「有新結果」都標成看過，狀態就會統一成「準備好了」" }, "✓ 全部看過了"));
  }
  const blocked = counts.blocked || 0;
  document.title = blocked ? `(${blocked}) herdr 控制台` : "herdr 控制台";
}

/* ---------- advanced tree ---------- */

function renderWorkspaces() {
  const root = $("workspaces");
  root.replaceChildren();
  const snapshot = state.snapshot;
  const workspaces = snapshot?.workspaces || [];
  $("empty-state").hidden = !state.online || workspaces.length > 0;
  for (const ws of workspaces) {
    const tabs = snapshot.tabs.filter((tab) => tab.workspace_id === ws.workspace_id).sort((a, b) => a.number - b.number);
    const card = h(
      "article",
      { class: `workspace${ws.focused ? " focused" : ""}` },
      h(
        "div",
        { class: "ws-head" },
        h("span", { class: `dot ${ws.agent_status}` }),
        h("h3", { text: ws.label || ws.workspace_id, title: ws.workspace_id }),
        h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "icon ghost", title: "新增分頁", "aria-label": "新增分頁", text: "＋", onclick: () => createTab(ws) }),
          h("button", { type: "button", class: "icon ghost", title: "重新命名", "aria-label": "重新命名工作區", text: "✎", onclick: () => renameWorkspace(ws) }),
          h("button", { type: "button", class: "icon ghost danger", title: "關閉工作區", "aria-label": "關閉工作區", text: "✕", onclick: () => closeWorkspace(ws) }),
        ),
      ),
    );
    for (const tab of tabs) {
      card.append(
        h(
          "div",
          { class: "tab-head" },
          h("span", { class: "name", text: tab.label && tab.label !== String(tab.number) ? `分頁 ${tab.number} · ${tab.label}` : `分頁 ${tab.number}` }),
          h(
            "div",
            { class: "actions" },
            h("button", { type: "button", class: "icon ghost", title: "重新命名分頁", "aria-label": "重新命名分頁", text: "✎", onclick: () => renameTab(tab) }),
            h("button", { type: "button", class: "icon ghost danger", title: "關閉分頁", "aria-label": "關閉分頁", text: "✕", onclick: () => closeTab(tab) }),
          ),
        ),
      );
      const list = h("ul", { class: "pane-list" });
      for (const pane of orderedPanes(tab.tab_id)) {
        list.append(
          h(
            "li",
            {},
            h(
              "button",
              { type: "button", class: `pane-row ${pane.agent_status}${pane.focused ? " focused" : ""}`, onclick: () => openPane(pane.pane_id) },
              h("span", { class: `dot ${pane.agent_status}` }),
              h("span", { class: "pane-main" }, h("span", { class: "pane-name", text: paneName(pane) }), h("span", { class: "pane-meta", text: paneMeta(pane) })),
              statusBadge(pane),
            ),
          ),
        );
      }
      card.append(list);
    }
    root.append(card);
  }
}

async function createWorkspace() {
  const values = await openForm({
    title: "新工作區",
    fields: [
      { name: "label", label: "名稱（可留空）" },
      { name: "kind", label: "建立後啟動", type: "select", value: "", options: [{ value: "", label: "只開終端機" }, ...agentOptions()] },
    ],
    okText: "下一步：選資料夾",
  });
  if (!values) return;
  const folder = await pickFolder("新工作區要用哪個資料夾？");
  if (!folder) return;
  if (values.kind) {
    const tool = AI_TOOLS[values.kind] || { kind: values.kind, name: AGENT_LABELS[values.kind] || values.kind };
    return startSession(tool, folder);
  }
  const params = { cwd: folder, focus: false };
  if (values.label) params.label = values.label;
  await run(() => call("workspace.create", params), "已建立工作區");
}

async function createTab(ws) {
  const values = await openForm({ title: `在「${ws.label}」新增分頁`, fields: [{ name: "label", label: "分頁名稱（可留空）" }], okText: "建立" });
  if (!values) return;
  const params = { workspace_id: ws.workspace_id, focus: false };
  if (values.label) params.label = values.label;
  await run(() => call("tab.create", params), "已新增分頁");
}

async function renameWorkspace(ws) {
  const values = await openForm({ title: "重新命名工作區", fields: [{ name: "label", label: "新名稱", value: ws.label, required: true }] });
  if (!values || !values.label) return;
  await run(() => call("workspace.rename", { workspace_id: ws.workspace_id, label: values.label }));
}

async function closeWorkspace(ws) {
  if (!(await confirmAction("關閉工作區？", `「${ws.label}」裡所有的視窗和正在跑的 AI 都會被關掉。`, "關閉"))) return;
  try {
    await call("workspace.close", { workspace_id: ws.workspace_id });
  } catch (err) {
    if (err.code !== "workspace_group_close_required") return toast(err.message, "error");
    if (!(await confirmAction("一起關閉？", "這個工作區還有相關的工作區，要全部一起關閉嗎？", "全部關閉"))) return;
    await run(() => call("workspace.close", { workspace_id: ws.workspace_id, close_group: true }));
  }
}

async function renameTab(tab) {
  const values = await openForm({ title: "重新命名分頁", fields: [{ name: "label", label: "新名稱", value: tab.label, required: true }] });
  if (!values || !values.label) return;
  await run(() => call("tab.rename", { tab_id: tab.tab_id, label: values.label }));
}

async function closeTab(tab) {
  if (!(await confirmAction("關閉分頁？", `分頁「${tab.label}」裡的視窗都會被關掉。`, "關閉"))) return;
  await run(() => call("tab.close", { tab_id: tab.tab_id }));
}

/* ---------- state updates ---------- */

function notifyTransitions() {
  const panes = state.snapshot?.panes || [];
  const next = new Map();
  for (const pane of panes) {
    const previous = state.lastStatuses.get(pane.pane_id);
    next.set(pane.pane_id, pane.agent_status);
    if (previous === undefined || previous === pane.agent_status) continue;
    if (pane.agent_status === "blocked" || pane.agent_status === "done") {
      const message = `${paneName(pane)}（${basename(paneFolder(pane))}）：${STATUS_LABELS[pane.agent_status]}`;
      toast(message);
      if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
        try {
          new Notification("herdr", { body: message, tag: pane.pane_id });
        } catch (err) {
          /* some mobile browsers only allow notifications from a service worker */
        }
      }
    }
  }
  state.lastStatuses = next;
}

function applyState(payload) {
  const wasOnline = state.online;
  state.online = Boolean(payload.online);
  state.error = payload.error;
  state.snapshot = payload.snapshot || (state.online ? state.snapshot : null);
  renderConnection();
  renderSummary();
  renderSessions();
  renderWorkspaces();
  if (state.online !== wasOnline) renderAiCards();
  if (state.online) notifyTransitions();
  if (state.openPaneId) {
    const pane = paneById(state.openPaneId);
    if (pane) {
      state.openPaneSeen = true;
      renderPaneHeader(pane);
    } else if (state.online && state.openPaneSeen) {
      // Only a pane we have already seen can have ended; a brand-new one may
      // simply be missing from a snapshot taken just before it was created.
      toast("這個對話已經結束了");
      closePane();
    }
  }
}

/* ---------- pane panel ---------- */

function renderPaneHeader(pane) {
  const tool = toolForPane(pane);
  $("pane-title").textContent = paneName(pane);
  $("pane-sub").textContent = `📁 ${paneFolder(pane)}`;
  const status = $("pane-status");
  status.className = `status ${pane.agent_status}`;
  status.textContent = statusLabel(pane);
  const name = tool ? tool.name : pane.display_agent || pane.agent;
  $("pane-input").placeholder = name ? `跟 ${name} 說…` : "輸入指令…";
  $("pane-answer").hidden = !pane.agent;
  const attention = $("pane-attention");
  attention.hidden = pane.agent_status !== "blocked";
  $("pane-attention-text").textContent = `${name || "程式"} 在等你回覆。看看畫面最後的問題，用下方的按鈕回答，或直接輸入文字。`;
}

/* herdr shows "done" until someone looks at the pane; focusing it marks it seen. */
function markSeen(paneId) {
  return call("pane.focus", { pane_id: paneId }).catch(() => undefined);
}

let markingAllSeen = false;
async function markAllSeen() {
  if (markingAllSeen) return;
  markingAllSeen = true;
  try {
    const done = (state.snapshot?.panes || []).filter((pane) => pane.agent && pane.agent_status === "done");
    for (const pane of done) await markSeen(pane.pane_id);
    toast("好了，狀態都統一了");
  } finally {
    markingAllSeen = false;
  }
}

function openPane(paneId) {
  state.openPaneId = paneId;
  const pane = paneById(paneId);
  if (pane?.agent_status === "done") markSeen(paneId);
  state.openPaneSeen = Boolean(pane);
  if (pane) renderPaneHeader(pane);
  else {
    $("pane-title").textContent = "啟動中…";
    $("pane-sub").textContent = "";
    $("pane-attention").hidden = true;
    $("pane-answer").hidden = false;
  }
  $("pane-output").textContent = "讀取中…";
  $("pane-link").hidden = true;
  $("pane-panel").hidden = false;
  refreshOutput(true);
  clearInterval(state.outputTimer);
  state.outputTimer = setInterval(() => refreshOutput(false), OUTPUT_POLL_MS);
}

function closePane() {
  const wasOpen = state.openPaneId !== null;
  state.openPaneId = null;
  clearInterval(state.outputTimer);
  state.outputTimer = null;
  $("pane-panel").hidden = true;
  // Coming back from an install window is the natural moment to look again.
  if (wasOpen && state.tools?.agents.some((agent) => !agent.installed)) loadTools(true);
}

/* Sign-in pages the AI tools send people to; links elsewhere stay plain text. */
const SIGN_IN_HOSTS = ["accounts.google.com", "auth.openai.com", "claude.ai", "claude.com", "console.anthropic.com", "accounts.x.ai", "auth.x.ai"];

/* Terminal tools print long sign-in URLs wrapped over several indented lines;
   join them back together and offer the newest one as a button. */
function findSignInLink(text) {
  const lines = text.split("\n");
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    let url = lines[i].trim();
    if (!/^https:\/\/\S+$/.test(url)) continue;
    while (i + 1 < lines.length && /^\S+$/.test(lines[i + 1].trim())) url += lines[++i].trim();
    try {
      const parsed = new URL(url);
      if (SIGN_IN_HOSTS.includes(parsed.hostname)) found = parsed.href;
    } catch (err) {
      /* not a URL after all */
    }
  }
  return found;
}

function showSignInLink(text) {
  const link = $("pane-link");
  const url = findSignInLink(text);
  link.hidden = !url;
  if (url && link.href !== url) link.href = url;
}

async function refreshOutput(forceScroll) {
  const paneId = state.openPaneId;
  if (!paneId || state.outputInFlight || document.hidden) return;
  state.outputInFlight = true;
  try {
    let result = await call("pane.read", { pane_id: paneId, source: "recent", lines: OUTPUT_LINES });
    // Full-screen programs draw on the alternate screen, which has no history.
    if (!result?.read?.text?.trim()) result = await call("pane.read", { pane_id: paneId, source: "visible" });
    if (paneId !== state.openPaneId) return;
    const output = $("pane-output");
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    const text = result?.read?.text ?? "";
    showSignInLink(text);
    if (output.textContent !== text) {
      output.textContent = text;
      if (atBottom || forceScroll) output.scrollTop = output.scrollHeight;
    }
  } catch (err) {
    if (err.code !== "network") $("pane-output").textContent = `無法讀取畫面：${err.message}`;
  } finally {
    state.outputInFlight = false;
  }
}

async function sendInput(event) {
  event.preventDefault();
  const paneId = state.openPaneId;
  const input = $("pane-input");
  const text = input.value;
  const pressEnter = $("pane-enter").checked;
  if (!paneId || (!text && !pressEnter)) return;
  const pane = paneById(paneId);
  const button = $("pane-send-btn");
  button.disabled = true;
  try {
    if (text && pressEnter && pane?.agent && pane.agent_status !== "blocked") {
      try {
        await call("agent.prompt", { target: paneId, text });
      } catch (err) {
        if (err.code !== "agent_blocked") throw err;
        await call("pane.send_text", { pane_id: paneId, text });
        await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
      }
    } else {
      if (text) await call("pane.send_text", { pane_id: paneId, text });
      if (pressEnter) await call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
    }
    input.value = "";
    setTimeout(() => refreshOutput(true), 300);
  } catch (err) {
    toast(err.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function sendKey(key) {
  const paneId = state.openPaneId;
  if (!paneId) return;
  await run(() => call("pane.send_keys", { pane_id: paneId, keys: [key] }));
  setTimeout(() => refreshOutput(false), 250);
}

async function startAgent() {
  const paneId = state.openPaneId;
  const options = agentOptions();
  if (!paneId) return;
  const values = await openForm({
    title: "在這個視窗啟動 AI",
    text: "視窗要停在可以輸入指令的狀態，而且這台電腦要先安裝好那個 AI 工具。",
    fields: [{ name: "kind", label: "要啟動哪一個", type: "select", value: options[0]?.value, options }],
    okText: "啟動",
  });
  if (!values || !values.kind) return;
  await run(() => launchInPane(paneId, values.kind));
  setTimeout(() => refreshOutput(true), 800);
}

async function splitPane(direction) {
  const paneId = state.openPaneId;
  if (!paneId) return;
  const result = await run(() => call("pane.split", { target_pane_id: paneId, direction, focus: false }), "已分割");
  const newPane = result?.pane?.pane_id;
  if (newPane) setTimeout(() => openPane(newPane), 300);
}

async function renamePane() {
  const pane = paneById(state.openPaneId);
  if (!pane) return;
  const values = await openForm({ title: "重新命名", fields: [{ name: "label", label: "名稱（留空恢復預設）", value: pane.label || "" }] });
  if (!values) return;
  await run(() => call("pane.rename", { pane_id: pane.pane_id, label: values.label || null }));
}

async function endPane(pane) {
  if (!(await confirmAction("結束這個對話？", `「${paneName(pane)}」和裡面正在跑的程式都會被關掉。你的檔案不會被刪除。`, "結束"))) return false;
  return Boolean(await run(() => call("pane.close", { pane_id: pane.pane_id }).then(() => true)));
}

async function killPane() {
  const pane = paneById(state.openPaneId);
  if (pane && (await endPane(pane))) closePane();
}

/* ---------- settings ---------- */

function renderToolList() {
  const list = $("tool-list");
  list.replaceChildren();
  const kinds = state.meta.preferred_agents?.length ? state.meta.preferred_agents : Object.keys(AI_TOOLS);
  for (const kind of kinds) {
    const tool = AI_TOOLS[kind] || { name: kind, product: kind };
    const status = toolStatus(kind);
    const text = !state.tools ? "檢查中…" : status?.installed ? "已安裝" : "還沒安裝";
    list.append(
      h(
        "div",
        { class: "tool-row" },
        h("span", { class: `ai-logo small ${tool.tone || "other"}`, text: tool.logo || "?", "aria-hidden": "true" }),
        h("span", { class: "session-main" }, h("strong", { text: `${tool.name}（${tool.product}）` }), h("span", { class: "muted small", text: status?.path || "" })),
        h("span", { class: status?.installed ? "ok" : "warn", text }),
        status && !status.installed
          ? h("button", { type: "button", class: "small", text: "安裝", onclick: () => offerInstall(kind, tool, status) })
          : null,
      ),
    );
  }
  list.append(h("div", { class: "button-row" }, h("button", { type: "button", class: "small ghost", text: "重新檢查", onclick: () => loadTools(true) })));
}

function renderNotifyStatus() {
  const button = $("notify-btn");
  const status = $("notify-status");
  if (!("Notification" in window)) {
    button.hidden = true;
    status.textContent = "這個瀏覽器不支援通知。";
  } else if (Notification.permission === "granted") {
    button.hidden = true;
    status.textContent = "已開啟。";
  } else if (Notification.permission === "denied") {
    button.hidden = true;
    status.textContent = "通知被瀏覽器封鎖了，可以在網址列左邊的設定裡打開。";
  } else {
    button.hidden = false;
    status.textContent = "";
  }
}

function renderLastFolder() {
  const folder = storageGet(LAST_FOLDER_KEY);
  $("last-folder").textContent = folder || "（還沒有，會從主資料夾開始）";
  $("clear-folder-btn").hidden = !folder;
}

function setConfigStatus(text, kind = "") {
  const el = $("config-status");
  el.textContent = text;
  el.className = `config-status ${kind}`;
}

function describeReload(reload) {
  if (!reload) return ["", ""];
  const diagnostics = reload.diagnostics || [];
  if (reload.status === "applied" && diagnostics.length === 0) return ["已儲存並套用。", "ok"];
  if (reload.status === "not_applied") return [`已儲存，但 herdr 沒有套用：\n${diagnostics.join("\n")}`, "warn"];
  return [`已儲存，herdr 回報部分設定有問題（狀態：${reload.status}）：\n${diagnostics.join("\n")}`, "warn"];
}

async function loadConfig(force = false) {
  if (state.configLoaded && !force) return;
  try {
    const data = await api("/api/config");
    $("config-path").textContent = data.path;
    $("config-editor").value = data.text;
    $("config-restore-btn").disabled = !data.has_backup;
    state.configLoaded = true;
    state.configDirty = false;
    let message = data.exists ? "" : "目前沒有設定檔，herdr 正在使用預設值，這是正常的。";
    if (!data.can_validate) message += (message ? "\n" : "") + "這台電腦的 Python 版本較舊，存檔前無法檢查語法。";
    setConfigStatus(message);
  } catch (err) {
    setConfigStatus(`讀取失敗：${err.message}`, "err");
  }
}

async function validateConfig() {
  const result = await run(() => api("/api/config/validate", { method: "POST", body: { text: $("config-editor").value } }));
  if (!result) return;
  if (!result.checked) setConfigStatus("無法檢查語法（Python 版本較舊）。", "warn");
  else if (result.valid) setConfigStatus("語法正確。", "ok");
  else setConfigStatus(`語法錯誤：${result.error}`, "err");
}

async function saveConfig() {
  const button = $("config-save-btn");
  button.disabled = true;
  try {
    const result = await api("/api/config", { method: "POST", body: { text: $("config-editor").value } });
    const [message, kind] = describeReload(result.reload);
    setConfigStatus(message, kind);
    state.configDirty = false;
    $("config-restore-btn").disabled = false;
  } catch (err) {
    setConfigStatus(err.code === "invalid_toml" ? `語法錯誤，沒有儲存：${err.message}` : `儲存失敗：${err.message}`, "err");
  } finally {
    button.disabled = false;
  }
}

async function restoreConfig() {
  if (!(await confirmAction("還原上一版？", "設定檔會換回上一次儲存前的版本。", "還原"))) return;
  try {
    const result = await api("/api/config/restore", { method: "POST", body: {} });
    await loadConfig(true);
    const [message, kind] = describeReload(result.reload);
    setConfigStatus(`已還原上一版。${message ? "\n" + message : ""}`, kind || "ok");
  } catch (err) {
    setConfigStatus(`還原失敗：${err.message}`, "err");
  }
}

async function showDefaultConfig() {
  const details = $("config-default");
  if (!$("config-default-text").textContent) {
    const result = await run(() => api("/api/config/default"));
    if (!result) return;
    $("config-default-text").textContent = result.text;
  }
  details.open = true;
  details.scrollIntoView({ behavior: "smooth", block: "start" });
}

function appendDefaultConfig() {
  const editor = $("config-editor");
  const text = $("config-default-text").textContent;
  if (!text) return;
  editor.value = editor.value.trimEnd() + (editor.value.trim() ? "\n\n" : "") + text;
  state.configDirty = true;
  setConfigStatus("已把預設設定附加到編輯器（還沒儲存）。被 # 註解掉的設定要拿掉 # 才會生效。");
  editor.focus();
}

/* ---------- views, login, boot ---------- */

function switchView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.view === view);
  $("chat-view").hidden = view !== "chat";
  $("home-view").hidden = view !== "home";
  $("settings-view").hidden = view !== "settings";
  if (view === "chat" && typeof chatShow === "function") chatShow();
  if (view === "settings") {
    renderToolList();
    renderNotifyStatus();
    renderLastFolder();
  }
}

function showLogin() {
  if (state.events) {
    state.events.close();
    state.events = null;
  }
  closePane();
  $("app-view").hidden = true;
  $("login-view").hidden = false;
  $("login-password").focus();
}

/* One event stream per page carries herdr state and, when a chat room is
   open, that room's changes: browsers allow only six connections per site
   across all tabs, and extra streams make every other request wait. */
function connectEvents() {
  if (state.events) state.events.close();
  const roomId = typeof chat !== "undefined" ? chat.roomId : null;
  const source = new EventSource(roomId ? `/api/events?room=${roomId}&since=${chat.rev}` : "/api/events");
  state.events = source;
  source.addEventListener("room", (event) => {
    if (typeof chat === "undefined" || chat.roomId !== roomId) return;
    try {
      applyRoomChanges(JSON.parse(event.data));
    } catch (err) {
      console.error("bad room event", err);
    }
  });
  source.addEventListener("state", (event) => {
    try {
      applyState(JSON.parse(event.data));
    } catch (err) {
      console.error("bad state event", err);
    }
  });
  source.addEventListener("error", async () => {
    $("conn-pill").textContent = "重新連線中";
    $("conn-pill").className = "pill";
    if (source.readyState === EventSource.CLOSED) {
      try {
        const session = await api("/api/session");
        showVersion(session.version);
        if (!session.authenticated) return showLogin();
      } catch (err) {
        /* network down; retry below */
      }
      setTimeout(() => {
        if (state.events === source) connectEvents();
      }, 3000);
    }
  });
}

async function enterApp() {
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  renderAiCards();
  try {
    state.meta = await api("/api/meta");
    applyState(await api("/api/state"));
  } catch (err) {
    if (err.status !== 401) toast(err.message, "error");
    return;
  }
  renderAiCards();
  connectEvents();
  loadTools(false);
  switchView(state.view);
}

async function login(event) {
  event.preventDefault();
  $("login-error").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("login-password").value } });
    $("login-password").value = "";
    await enterApp();
  } catch (err) {
    $("login-error").textContent = err.code === "bad_password" ? "密碼錯誤" : err.message;
  }
}

async function logout() {
  await run(() => api("/api/logout", { method: "POST", body: {} }));
  state.configLoaded = false;
  showLogin();
}

function bind() {
  $("login-form").addEventListener("submit", login);
  $("logout-btn").addEventListener("click", logout);
  for (const tab of document.querySelectorAll(".tab")) tab.addEventListener("click", () => switchView(tab.dataset.view));
  $("recheck-btn").addEventListener("click", () => loadTools(true));
  $("new-workspace-btn").addEventListener("click", createWorkspace);
  $("start-server-btn").addEventListener("click", () => run(() => api("/api/server/start", { method: "POST", body: {} }), "正在啟動 herdr…"));

  $("folder-new-btn").addEventListener("click", createFolder);
  $("folder-up-btn").addEventListener("click", () => {
    if (state.folder?.parent) showFolder(state.folder.parent);
  });

  $("pane-close-btn").addEventListener("click", closePane);
  $("pane-input-form").addEventListener("submit", sendInput);
  $("pane-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) sendInput(event);
  });
  for (const id of ["pane-keys", "pane-answer-keys"]) {
    $(id).addEventListener("click", (event) => {
      const key = event.target.closest("button")?.dataset.key;
      if (key) sendKey(key);
    });
  }
  $("pane-start-agent-btn").addEventListener("click", startAgent);
  $("pane-split-right-btn").addEventListener("click", () => splitPane("right"));
  $("pane-split-down-btn").addEventListener("click", () => splitPane("down"));
  $("pane-rename-btn").addEventListener("click", renamePane);
  $("pane-kill-btn").addEventListener("click", killPane);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("pane-panel").hidden && !$("form-dialog").open && !$("folder-dialog").open) closePane();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshOutput(false);
  });

  $("notify-btn").addEventListener("click", () => Notification.requestPermission().then(renderNotifyStatus));
  $("clear-folder-btn").addEventListener("click", () => {
    storageSet(LAST_FOLDER_KEY, null);
    renderLastFolder();
  });

  $("config-section").addEventListener("toggle", () => {
    if ($("config-section").open) loadConfig();
  });
  $("config-editor").addEventListener("input", () => {
    state.configDirty = true;
  });
  $("config-validate-btn").addEventListener("click", validateConfig);
  $("config-save-btn").addEventListener("click", saveConfig);
  $("config-restore-btn").addEventListener("click", restoreConfig);
  $("config-default-btn").addEventListener("click", showDefaultConfig);
  $("config-copy-default-btn").addEventListener("click", appendDefaultConfig);
  window.addEventListener("beforeunload", (event) => {
    if (state.configDirty) event.preventDefault();
  });
}

function takeLoginFromUrl() {
  // The Mac app and start.sh pass a password in the fragment; never keep it in history.
  const params = new URLSearchParams(location.hash.slice(1));
  const password = params.get("login");
  if (password !== null) history.replaceState(null, "", location.pathname + location.search);
  return password;
}

function showVersion(version) {
  if (!version) return;
  for (const el of document.querySelectorAll(".app-version")) el.textContent = `v${version}`;
}

async function boot() {
  bind();
  const urlPassword = takeLoginFromUrl();
  try {
    const session = await api("/api/session");
    showVersion(session.version);
    if (session.authenticated) return await enterApp();
    if (urlPassword) {
      try {
        await api("/api/login", { method: "POST", body: { password: urlPassword } });
        return await enterApp();
      } catch (err) {
        /* stale link from an earlier run: fall back to the login form */
      }
    }
    showLogin();
  } catch (err) {
    showLogin();
    $("login-error").textContent = err.message;
  }
}

// chat.js loads after this file; wait for both before starting.
document.addEventListener("DOMContentLoaded", boot);
