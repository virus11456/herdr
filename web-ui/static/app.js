"use strict";

const STATUS_LABELS = {
  working: "工作中",
  blocked: "等你回應",
  done: "完成",
  idle: "閒置",
  unknown: "未偵測",
};
const STATUS_ORDER = ["blocked", "working", "done", "idle"];
const AGENT_LABELS = {
  claude: "Claude Code（Claude 訂閱）",
  codex: "Codex（ChatGPT 訂閱）",
  grok: "Grok CLI（Grok 訂閱）",
  gemini: "Gemini CLI",
  copilot: "GitHub Copilot CLI",
  cursor: "Cursor Agent CLI",
  opencode: "OpenCode",
};
const OUTPUT_POLL_MS = 1500;
const OUTPUT_LINES = 400;

const state = {
  online: false,
  error: null,
  snapshot: null,
  meta: { agent_kinds: [], preferred_agents: [] },
  view: "dashboard",
  openPaneId: null,
  lastStatuses: new Map(),
  events: null,
  outputTimer: null,
  outputInFlight: false,
  configLoaded: false,
  configDirty: false,
};

const $ = (id) => document.getElementById(id);

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
    throw new ApiError("network", "無法連到 herdr-web，請檢查網路。", 0);
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

function openForm({ title, text = "", fields = [], okText = "確定", danger = false }) {
  const dialog = $("form-dialog");
  const container = $("form-dialog-fields");
  $("form-dialog-title").textContent = title;
  $("form-dialog-text").textContent = text;
  $("form-dialog-text").hidden = !text;
  const ok = $("form-dialog-ok");
  ok.textContent = okText;
  ok.className = danger ? "danger" : "primary";
  container.replaceChildren();
  const inputs = {};
  for (const field of fields) {
    const id = `field-${field.name}`;
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
      for (const [name, input] of Object.entries(inputs)) values[name] = input.value.trim();
      resolve(values);
    };
    dialog.addEventListener("close", onClose);
    dialog.returnValue = "";
    dialog.showModal();
    const first = Object.values(inputs)[0];
    if (first) first.focus();
  });
}

async function confirmAction(title, text, okText) {
  return (await openForm({ title, text, okText, danger: true })) !== null;
}

function agentOptions() {
  const preferred = new Set(state.meta.preferred_agents || []);
  return (state.meta.agent_kinds || []).map((kind) => ({
    value: kind,
    label: AGENT_LABELS[kind] || kind,
    group: preferred.size ? (preferred.has(kind) ? "你的訂閱" : "其他 agent") : undefined,
  }));
}

/* ---------- snapshot helpers ---------- */

function agentForPane(paneId) {
  return (state.snapshot?.agents || []).find((agent) => agent.pane_id === paneId) || null;
}

function paneById(paneId) {
  return (state.snapshot?.panes || []).find((pane) => pane.pane_id === paneId) || null;
}

function paneName(pane) {
  const agent = agentForPane(pane.pane_id);
  return (
    agent?.name ||
    pane.label ||
    pane.display_agent ||
    pane.terminal_title_stripped ||
    pane.title ||
    pane.pane_id
  );
}

function paneMeta(pane) {
  const parts = [];
  if (pane.display_agent || pane.agent) parts.push(pane.display_agent || pane.agent);
  const cwd = pane.foreground_cwd || pane.cwd;
  if (cwd) parts.push(cwd);
  parts.push(pane.pane_id);
  return parts.join(" · ");
}

function orderedPanes(tabId) {
  const snapshot = state.snapshot;
  const panes = snapshot.panes.filter((pane) => pane.tab_id === tabId);
  const layout = (snapshot.layouts || []).find((item) => item.tab_id === tabId);
  if (!layout) return panes;
  const order = new Map(layout.panes.map((item, index) => [item.pane_id, index]));
  return panes.sort((a, b) => (order.get(a.pane_id) ?? 99) - (order.get(b.pane_id) ?? 99));
}

function statusBadge(status) {
  const value = STATUS_LABELS[status] ? status : "unknown";
  return h("span", { class: `status ${value}`, text: STATUS_LABELS[value] });
}

/* ---------- dashboard rendering ---------- */

function renderConnection() {
  const pill = $("conn-pill");
  if (state.online) {
    pill.textContent = `herdr ${state.snapshot?.version || ""}`.trim();
    pill.className = "pill online";
  } else {
    pill.textContent = "離線";
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
  for (const pane of panes) counts[pane.agent_status] = (counts[pane.agent_status] || 0) + 1;
  for (const status of STATUS_ORDER) {
    if (!counts[status]) continue;
    summary.append(h("span", { class: "chip" }, h("span", { class: `dot ${status}` }), `${STATUS_LABELS[status]} ${counts[status]}`));
  }
  if ("Notification" in window && window.isSecureContext && Notification.permission === "default") {
    summary.append(
      h("button", {
        type: "button",
        class: "small ghost",
        text: "開啟通知",
        onclick: () => Notification.requestPermission().then(renderSummary),
      }),
    );
  }
  const blocked = counts.blocked || 0;
  document.title = blocked ? `(${blocked}) herdr 控制台` : "herdr 控制台";
}

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
          h("button", { type: "button", class: "icon ghost", title: "新增 tab", "aria-label": "新增 tab", text: "＋", onclick: () => createTab(ws) }),
          h("button", { type: "button", class: "icon ghost", title: "重新命名", "aria-label": "重新命名 workspace", text: "✎", onclick: () => renameWorkspace(ws) }),
          h("button", { type: "button", class: "icon ghost danger", title: "關閉 workspace", "aria-label": "關閉 workspace", text: "✕", onclick: () => closeWorkspace(ws) }),
        ),
      ),
    );
    for (const tab of tabs) {
      card.append(
        h(
          "div",
          { class: "tab-head" },
          h("span", { class: "name", text: tab.label && tab.label !== String(tab.number) ? `Tab ${tab.number} · ${tab.label}` : `Tab ${tab.number}` }),
          h(
            "div",
            { class: "actions" },
            h("button", { type: "button", class: "icon ghost", title: "重新命名 tab", "aria-label": "重新命名 tab", text: "✎", onclick: () => renameTab(tab) }),
            h("button", { type: "button", class: "icon ghost danger", title: "關閉 tab", "aria-label": "關閉 tab", text: "✕", onclick: () => closeTab(tab) }),
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
              {
                type: "button",
                class: `pane-row ${pane.agent_status}${pane.focused ? " focused" : ""}`,
                onclick: () => openPane(pane.pane_id),
              },
              h("span", { class: `dot ${pane.agent_status}` }),
              h("span", { class: "pane-main" }, h("span", { class: "pane-name", text: paneName(pane) }), h("span", { class: "pane-meta", text: paneMeta(pane) })),
              statusBadge(pane.agent_status),
            ),
          ),
        );
      }
      card.append(list);
    }
    root.append(card);
  }
}

function notifyTransitions() {
  const panes = state.snapshot?.panes || [];
  const next = new Map();
  for (const pane of panes) {
    const previous = state.lastStatuses.get(pane.pane_id);
    next.set(pane.pane_id, pane.agent_status);
    if (previous === undefined || previous === pane.agent_status) continue;
    if (pane.agent_status === "blocked" || pane.agent_status === "done") {
      const message = `${paneName(pane)}：${STATUS_LABELS[pane.agent_status]}`;
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
  state.online = Boolean(payload.online);
  state.error = payload.error;
  state.snapshot = payload.snapshot || (state.online ? state.snapshot : null);
  renderConnection();
  renderSummary();
  renderWorkspaces();
  if (state.online) notifyTransitions();
  if (state.openPaneId) {
    const pane = paneById(state.openPaneId);
    if (pane) renderPaneHeader(pane);
    else if (state.online) {
      toast("這個 pane 已經關閉了");
      closePane();
    }
  }
}

/* ---------- workspace / tab actions ---------- */

async function createWorkspace() {
  const values = await openForm({
    title: "新 workspace",
    fields: [
      { name: "label", label: "名稱", placeholder: "例如 api、frontend" },
      { name: "cwd", label: "工作目錄（絕對路徑，留空用預設）", placeholder: "/home/me/project" },
      {
        name: "kind",
        label: "建立後啟動 agent",
        type: "select",
        value: "",
        options: [{ value: "", label: "不要，只開 shell" }, ...agentOptions()],
      },
    ],
    okText: "建立",
  });
  if (!values) return;
  const params = { focus: false };
  if (values.label) params.label = values.label;
  if (values.cwd) params.cwd = values.cwd;
  const result = await run(() => call("workspace.create", params), "已建立 workspace");
  const paneId = result?.root_pane?.pane_id;
  if (paneId && values.kind) {
    await startAgentInPane(paneId, values.kind, values.label || values.kind, true);
  }
}

async function createTab(ws) {
  const values = await openForm({ title: `在 ${ws.label} 新增 tab`, fields: [{ name: "label", label: "Tab 名稱（可留空）" }], okText: "建立" });
  if (!values) return;
  const params = { workspace_id: ws.workspace_id, focus: false };
  if (values.label) params.label = values.label;
  await run(() => call("tab.create", params), "已新增 tab");
}

async function renameWorkspace(ws) {
  const values = await openForm({ title: "重新命名 workspace", fields: [{ name: "label", label: "新名稱", value: ws.label, required: true }] });
  if (!values || !values.label) return;
  await run(() => call("workspace.rename", { workspace_id: ws.workspace_id, label: values.label }));
}

async function closeWorkspace(ws) {
  if (!(await confirmAction("關閉 workspace？", `「${ws.label}」裡的所有 tab、pane 和正在跑的 agent 都會被關掉。`, "關閉"))) return;
  try {
    await call("workspace.close", { workspace_id: ws.workspace_id });
  } catch (err) {
    if (err.code !== "workspace_group_close_required") return toast(err.message, "error");
    if (!(await confirmAction("一起關閉 worktree？", "這個 workspace 還有連結的 worktree workspace，要全部一起關閉嗎？", "全部關閉"))) return;
    await run(() => call("workspace.close", { workspace_id: ws.workspace_id, close_group: true }));
  }
}

async function renameTab(tab) {
  const values = await openForm({ title: "重新命名 tab", fields: [{ name: "label", label: "新名稱", value: tab.label, required: true }] });
  if (!values || !values.label) return;
  await run(() => call("tab.rename", { tab_id: tab.tab_id, label: values.label }));
}

async function closeTab(tab) {
  if (!(await confirmAction("關閉 tab？", `Tab「${tab.label}」裡的 pane 都會被關掉。`, "關閉"))) return;
  await run(() => call("tab.close", { tab_id: tab.tab_id }));
}

/* ---------- pane panel ---------- */

function renderPaneHeader(pane) {
  $("pane-title").textContent = paneName(pane);
  $("pane-sub").textContent = paneMeta(pane);
  const status = $("pane-status");
  status.className = `status ${pane.agent_status}`;
  status.textContent = STATUS_LABELS[pane.agent_status] || STATUS_LABELS.unknown;
  $("pane-input").placeholder = pane.agent ? `給 ${pane.display_agent || pane.agent} 的指令…` : "輸入 shell 指令…";
}

function openPane(paneId) {
  const pane = paneById(paneId);
  if (!pane) return;
  state.openPaneId = paneId;
  renderPaneHeader(pane);
  $("pane-output").textContent = "讀取中…";
  $("pane-panel").hidden = false;
  refreshOutput(true);
  clearInterval(state.outputTimer);
  state.outputTimer = setInterval(() => refreshOutput(false), OUTPUT_POLL_MS);
}

function closePane() {
  state.openPaneId = null;
  clearInterval(state.outputTimer);
  state.outputTimer = null;
  $("pane-panel").hidden = true;
}

async function refreshOutput(forceScroll) {
  const paneId = state.openPaneId;
  if (!paneId || state.outputInFlight || document.hidden) return;
  state.outputInFlight = true;
  try {
    const result = await call("pane.read", { pane_id: paneId, source: "recent", lines: OUTPUT_LINES });
    if (paneId !== state.openPaneId) return;
    const output = $("pane-output");
    const atBottom = output.scrollHeight - output.scrollTop - output.clientHeight < 40;
    const text = result?.read?.text ?? "";
    if (output.textContent !== text) {
      output.textContent = text;
      if (atBottom || forceScroll) output.scrollTop = output.scrollHeight;
    }
  } catch (err) {
    if (err.code !== "network") $("pane-output").textContent = `無法讀取輸出：${err.message}`;
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

async function startAgentInPane(paneId, kind, name, freshPane) {
  // A brand-new pane needs a moment before its shell prompt is ready.
  if (freshPane) await new Promise((resolve) => setTimeout(resolve, 1200));
  toast(`正在啟動 ${kind}…`);
  await run(() => call("agent.start", { pane_id: paneId, kind, name, timeout_ms: 30000 }), `${kind} 已就緒`);
}

async function startAgent() {
  const paneId = state.openPaneId;
  const options = agentOptions();
  if (!paneId) return;
  const values = await openForm({
    title: "在這個 pane 啟動 agent",
    text: "pane 必須停在 shell 提示字元，而且 VPS 上要先安裝好該 agent 的 CLI。",
    fields: [
      { name: "kind", label: "Agent 種類", type: "select", value: options[0]?.value, options },
      { name: "name", label: "名稱", placeholder: "例如 reviewer" },
    ],
    okText: "啟動",
  });
  if (!values || !values.kind) return;
  await startAgentInPane(paneId, values.kind, values.name || values.kind, false);
}

async function splitPane(direction) {
  const paneId = state.openPaneId;
  if (!paneId) return;
  const result = await run(() => call("pane.split", { target_pane_id: paneId, direction, focus: false }), "已分割 pane");
  const newPane = result?.pane?.pane_id;
  if (newPane) setTimeout(() => openPane(newPane), 300);
}

async function renamePane() {
  const pane = paneById(state.openPaneId);
  if (!pane) return;
  const values = await openForm({ title: "重新命名 pane", fields: [{ name: "label", label: "名稱（留空清除）", value: pane.label || "" }] });
  if (!values) return;
  await run(() => call("pane.rename", { pane_id: pane.pane_id, label: values.label || null }));
}

async function killPane() {
  const pane = paneById(state.openPaneId);
  if (!pane) return;
  if (!(await confirmAction("關閉 pane？", `「${paneName(pane)}」和裡面正在跑的程式都會被終止。`, "關閉"))) return;
  const ok = await run(() => call("pane.close", { pane_id: pane.pane_id }).then(() => true));
  if (ok) closePane();
}

/* ---------- settings ---------- */

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
    let message = data.exists ? "" : "目前還沒有 config.toml，herdr 正在使用預設值。儲存後就會建立。";
    if (!data.can_validate) message += (message ? "\n" : "") + "伺服器的 Python 版本低於 3.11，無法事先檢查 TOML 語法。";
    setConfigStatus(message);
  } catch (err) {
    setConfigStatus(`讀取失敗：${err.message}`, "err");
  }
}

async function validateConfig() {
  const result = await run(() => api("/api/config/validate", { method: "POST", body: { text: $("config-editor").value } }));
  if (!result) return;
  if (!result.checked) setConfigStatus("無法檢查語法（伺服器 Python 低於 3.11）。", "warn");
  else if (result.valid) setConfigStatus("TOML 語法正確。", "ok");
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
  if (!(await confirmAction("還原上一版？", "編輯器裡和目前的 config.toml 都會換成上一次儲存前的版本。", "還原"))) return;
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
  setConfigStatus("已把預設設定附加到編輯器（還沒儲存）。被註解掉的設定拿掉 # 才會生效。");
  editor.focus();
}

/* ---------- views, login, boot ---------- */

function switchView(view) {
  state.view = view;
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.view === view);
  $("dashboard-view").hidden = view !== "dashboard";
  $("settings-view").hidden = view !== "settings";
  if (view === "settings") loadConfig();
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

function connectEvents() {
  if (state.events) state.events.close();
  const source = new EventSource("/api/events");
  state.events = source;
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
  try {
    state.meta = await api("/api/meta");
    applyState(await api("/api/state"));
  } catch (err) {
    if (err.status !== 401) toast(err.message, "error");
    return;
  }
  connectEvents();
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
  $("new-workspace-btn").addEventListener("click", createWorkspace);
  $("start-server-btn").addEventListener("click", () => run(() => api("/api/server/start", { method: "POST", body: {} }), "已送出啟動指令"));

  $("pane-close-btn").addEventListener("click", closePane);
  $("pane-input-form").addEventListener("submit", sendInput);
  $("pane-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) sendInput(event);
  });
  $("pane-keys").addEventListener("click", (event) => {
    const key = event.target.closest("button")?.dataset.key;
    if (key) sendKey(key);
  });
  $("pane-start-agent-btn").addEventListener("click", startAgent);
  $("pane-split-right-btn").addEventListener("click", () => splitPane("right"));
  $("pane-split-down-btn").addEventListener("click", () => splitPane("down"));
  $("pane-rename-btn").addEventListener("click", renamePane);
  $("pane-kill-btn").addEventListener("click", killPane);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("pane-panel").hidden && !$("form-dialog").open) closePane();
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshOutput(false);
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
  // herdr-web --open passes a one-run password in the fragment; never keep it in history.
  const params = new URLSearchParams(location.hash.slice(1));
  const password = params.get("login");
  if (password !== null) history.replaceState(null, "", location.pathname + location.search);
  return password;
}

async function boot() {
  bind();
  const urlPassword = takeLoginFromUrl();
  try {
    const session = await api("/api/session");
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

boot();
