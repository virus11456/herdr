import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

export const recoverable = new Set(['rate_limit', 'server_error', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error', 'model_not_found', 'cloud_credential_error']);
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function context(cwd = process.cwd(), terminal = process.env.HC_TERMINAL_ID, run) {
  return { cwd: path.resolve(cwd), terminal, run: run || ((cmd, args) => JSON.parse(execFileSync(path.join(os.homedir(), '.local/bin', cmd), args, { cwd, encoding: 'utf8', timeout: 75000, maxBuffer: 1024 * 1024 }))) };
}
function paths(c) {
  const dir = path.join(c.cwd, '.herdr-team');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, control: path.join(dir, 'control.json'), lock: path.join(dir, 'takeover.lock'), messages: path.join(dir, 'messages.jsonl') };
}
export function log(c, role, text) {
  if (!String(text).trim()) return;
  const p = paths(c);
  fs.appendFileSync(p.messages, JSON.stringify({ time: new Date().toISOString(), terminal: c.terminal || null, role: String(role).slice(0, 40), text: String(text).slice(0, 12000) }) + '\n', { mode: 0o600 });
}
export function report(c, target, role, text) {
  if (!/^t[a-z0-9]+$/.test(target || '')) throw new Error('A local coordinator terminal ID is required.');
  const p = paths(c), dir = path.join(p.dir, 'outbox');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  save(path.join(dir, `${id}.json`), { id, target, role, text: String(text), from: c.terminal || null });
  log(c, role, text);
  return { queued: true, id };
}
export function drain(c) {
  const requestsProcessed = drainRequests(c);
  const dir = path.join(c.cwd, '.herdr-team/outbox');
  if (!fs.existsSync(dir)) return { delivered: 0, errors: [], requestsProcessed };
  let delivered = 0;
  const errors = [];
  for (const name of fs.readdirSync(dir).filter(x => /^[a-f0-9-]+\.json$/.test(x))) {
    const file = path.join(dir, name), pending = file + '.sending';
    try { fs.renameSync(file, pending); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    try {
      const msg = read(pending);
      if (!/^t[a-z0-9]+$/.test(msg.target || '') || typeof msg.text !== 'string') throw new Error('Invalid queued report.');
      const control = read(path.join(c.cwd, '.herdr-team/control.json'));
      const target = control?.role === 'codex' && msg.target === control.previousTerminal ? control.terminal : msg.target;
      if (!target) throw new Error('Coordinator handover is still in progress.');
      c.run('hc', ['send', target, `[Herdr report ${msg.id}; from ${msg.from || msg.role}${target !== msg.target ? `; forwarded from ${msg.target}` : ''}] ${msg.text}`]);
      fs.renameSync(pending, file + '.sent');
      delivered++;
    } catch (e) {
      fs.renameSync(pending, file);
      errors.push(String(e.message));
    }
  }
  return { delivered, errors, requestsProcessed };
}
export function request(c, action, args) {
  if (!c.terminal) throw new Error('Requests must originate in a Herdr terminal.');
  const p = paths(c), dir = path.join(p.dir, 'requests'), id = randomUUID();
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.mkdirSync(path.join(p.dir, 'responses'), {recursive: true, mode: 0o700});
  save(path.join(dir, `${id}.json`), {id, sender: c.terminal, action, args});
  return {queued: true, id, response: path.join(p.dir, 'responses', `${id}.json`)};
}
export function executeRequest(c, req) {
  const control = read(path.join(c.cwd, '.herdr-team/control.json'));
  if (!control?.terminal || req.sender !== control.terminal) throw new Error('Only the active coordinator may request operations.');
  const a = req.args || {};
  if (req.action === 'templates') return c.run('hc', ['templates']);
  if (req.action === 'list') {
    const all = c.run('hc', ['ls', '--json']);
    const owners = [control.terminal, control.previousTerminal].filter(Boolean);
    return {terminals: (Array.isArray(all) ? all : all.terminals || []).filter(t => owners.includes(t.parent) || owners.includes(t.address || t.id || t.terminal))};
  }
  if (req.action === 'run') {
    if (!['herdr-codex-implement', 'herdr-minimax-cn'].includes(a.template)) throw new Error('Unknown worker template.');
    if (!/^[a-z0-9_-]{1,32}$/.test(a.name || '') || typeof a.task !== 'string' || !a.task.trim()) throw new Error('A valid worker name and task are required.');
    const root = fs.realpathSync(c.cwd), cwd = fs.realpathSync(path.resolve(c.cwd, a.cwd || '.'));
    if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error('Worker cwd must remain inside this project.');
    return c.run('hc', ['run', '--bg', '--name', a.name, '--cwd', cwd, '--parent', control.terminal, a.template, a.task]);
  }
  if (!['get', 'read', 'wait', 'send', 'interrupt'].includes(req.action)) throw new Error('Unsupported coordinator operation.');
  if (!/^t[a-z0-9]+$/.test(a.terminal || '')) throw new Error('A local worker terminal is required.');
  const terminal = c.run('hc', ['get', a.terminal]);
  const previousRead = a.terminal === control.previousTerminal && ['get', 'read'].includes(req.action);
  if (![control.terminal, control.previousTerminal].filter(Boolean).includes(terminal.parent) && a.terminal !== control.terminal && !previousRead) throw new Error('This terminal does not belong to the current team.');
  if (req.action === 'get') return terminal;
  if (req.action === 'read') return c.run('hc', ['read', a.terminal, '--json', '--lines', String(Math.max(0, Math.min(80, Number(a.lines) || 0)))]);
  if (req.action === 'wait') return c.run('hc', ['wait', a.terminal, '--timeout', '8']);
  if (req.action === 'send') {
    if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('A message is required.');
    return c.run('hc', ['send', a.terminal, a.text]);
  }
  return c.run('hc', ['interrupt', a.terminal]);
}
export function drainRequests(c) {
  const dir = path.join(c.cwd, '.herdr-team/requests');
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(dir).filter(x => /^[a-f0-9-]+\.json$/.test(x))) {
    const file = path.join(dir, name), pending = file + '.running';
    try { fs.renameSync(file, pending); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const req = read(pending);
    let response;
    try { response = {ok: true, result: executeRequest(c, req)}; }
    catch (error) { response = {ok: false, error: String(error.message)}; }
    save(path.join(c.cwd, '.herdr-team/responses', name), response);
    fs.renameSync(pending, file + '.done');
    count++;
  }
  return count;
}
async function response(c, id) {
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid request ID.');
  const dir = path.join(c.cwd, '.herdr-team/responses'), file = path.join(dir, `${id}.json`);
  if (fs.existsSync(file)) return read(file);
  return new Promise((resolve, reject) => {
    const watcher = fs.watch(dir, () => { if (fs.existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(read(file)); } });
    const timer = setTimeout(() => { watcher.close(); reject(new Error('Response is still pending; keep the request ID and check again.')); }, 60000);
    if (fs.existsSync(file)) { clearTimeout(timer); watcher.close(); resolve(read(file)); }
  });
}
export function register(c, role) {
  if (!c.terminal) return { registered: false, reason: 'not_in_herdr' };
  const p = paths(c), registrationLock = path.join(p.dir, 'register.lock');
  let registration;
  try { registration = fs.openSync(registrationLock, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw new Error('Another coordinator is being registered; retry from the panel.'); throw e; }
  try {
  const old = read(p.control);
  if (old?.terminal && old.terminal !== c.terminal) {
    let t;
    try { t = c.run('hc', ['get', old.terminal]); } catch { throw new Error('Cannot verify the previous coordinator; refusing to create a second one.'); }
    if (t.state === 'live' && ((t.status?.app && !['done', 'error'].includes(t.status.state)) || (!t.status?.app && Date.now() - old.startedAt < 60000))) throw new Error('This project already has a coordinator. Use the panel to continue or take over.');
  }
  const state = { ...old, terminal: c.terminal, role, phase: 'active', startedAt: Date.now() };
  save(p.control, state);
  log(c, role, role === 'claude' ? 'Claude 主總控已連線。' : 'Codex 備援總控已連線；先讀交接紀錄再接手。');
  return state;
  } finally { fs.closeSync(registration); fs.unlinkSync(registrationLock); }
}
export function takeover(c, reason, automatic = false) {
  const p = paths(c);
  let fd;
  try { fd = fs.openSync(p.lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') return { switched: false, reason: 'transition_in_progress' }; throw e; }
  try {
    const old = read(p.control);
    if (!old?.terminal || old.role !== 'claude' || (c.terminal && old.terminal !== c.terminal)) return { switched: false, reason: 'not_active_claude' };
    const t = c.run('hc', ['get', old.terminal]);
    if (t.status?.state === 'blocked' && (!automatic || ['permission', 'question'].includes(t.status.kind))) throw new Error('Claude is waiting for a user or permission decision; handle it in the terminal before switching.');
    if (!automatic && t.status?.state === 'working') {
      c.run('hc', ['interrupt', old.terminal]);
      c.run('hc', ['wait', old.terminal, '--timeout', '5']);
      const after = c.run('hc', ['get', old.terminal]);
      if (after.status?.state === 'working' || after.status?.state === 'blocked') throw new Error('The previous coordinator has not stopped; takeover was not started.');
    }
    const handoff = { ...old, terminal: null, previousTerminal: old.terminal, role: 'codex', phase: 'handoff', reason, switchedAt: Date.now(), startedAt: Date.now() };
    save(p.control, handoff);
    const args = { name: 'Codex · 備援總控', folder: c.cwd, argv: [path.join(os.homedir(), '.local/bin/herdr-team-backup'), `前一位總控 ${old.terminal} 已停止當前回合，切換原因：${reason}。讀取 TASK.md（若存在）、.herdr-team/STATUS.md 及現有 worker 終端狀態，接手未完成的工作，避免重複派工。`], focus: true };
    if (reason.startsWith('simulated_')) args.argv[1] = '這是已完成任務後的備援演練，不是 Claude 真正耗盡額度。請只讀取 TASK.md、RESULT.md 與 .herdr-team/STATUS.md，核對既有工作代理和產物，寫一份簡短的 BACKUP-CHECK.md，確認能接手且不重複派工。不要修改實作、不要啟動其他代理，不要擴大到修復報告中的品質建議。完成後可用 herdr-team-runtime log Codex 記錄摘要。';
    if (t.labels?.['herdr.space']) args.space = t.labels['herdr.space'];
    let made;
    try {
      made = c.run('herdr-app', ['do', 'tab.new', JSON.stringify(args)]);
      if (!made.terminal) throw new Error('Herdr did not return a terminal.');
    } catch (e) {
      save(p.control, { ...old, phase: 'handoff_failed', failure: String(e.message) });
      throw e;
    }
    save(p.control, { ...handoff, terminal: made.terminal, tab: made.tab, phase: 'active' });
    log(c, '系統', `${automatic ? '自動' : '手動'}切換至 Codex 備援總控：${reason}；終端 ${made.terminal}。`);
    return { switched: true, terminal: made.terminal, reason };
  } finally { fs.closeSync(fd); fs.unlinkSync(p.lock); }
}
export function handleFailure(event, c) {
  if (event.hook_event_name !== 'StopFailure' || !recoverable.has(event.error)) return { switched: false, reason: 'not_a_recoverable_api_failure' };
  return takeover(c, event.simulated === true ? `simulated_${event.error}` : event.error, true);
}
export function hooksSettings(runtime, node) {
  const quote = x => "'" + String(x).replace(/'/g, "'\\''") + "'";
  return { hooks: { StopFailure: [{ matcher: [...recoverable].join('|'), hooks: [{ type: 'command', command: `${quote(node)} ${quote(runtime)} hook`, timeout: 20 }] }] } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [cmd, ...args] = process.argv.slice(2);
    let result;
    if (['help', '--help', '-h'].includes(cmd)) result = { usage: 'herdr-team-runtime register claude|codex; report <coordinator-id> <role> <summary>; request <action> <json>; response <id>; log <role> <summary>; drain; takeover <project>' };
    else if (cmd === 'hook') {
      const event = JSON.parse(fs.readFileSync(0, 'utf8'));
      result = handleFailure(event, context(event.cwd || process.cwd()));
    } else if (cmd === 'register') result = register(context(), args[0]);
    else if (cmd === 'takeover') result = takeover(context(args[0] || process.cwd(), null), 'user_requested', false);
    else if (cmd === 'log') result = log(context(), args[0], args.slice(1).join(' '));
    else if (cmd === 'report') result = report(context(), args[0], args[1], args.slice(2).join(' '));
    else if (cmd === 'drain') result = drain(context());
    else if (cmd === 'request') result = request(context(), args[0], JSON.parse(args[1] || '{}'));
    else if (cmd === 'response') result = await response(context(), args[0]);
    else if (cmd === 'settings') result = hooksSettings(args[0], args[1]);
    else throw new Error('Unknown runtime command');
    if (cmd !== 'hook') process.stdout.write(JSON.stringify(result ?? { ok: true }) + '\n');
  } catch (error) { console.error(`Herdr team: ${error.message}`); process.exitCode = 1; }
}
