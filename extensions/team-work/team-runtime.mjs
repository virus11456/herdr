import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const recoverable = new Set(['rate_limit', 'server_error', 'authentication_failed', 'oauth_org_not_allowed', 'account_on_hold', 'billing_error', 'model_not_found', 'cloud_credential_error']);
export const claudeModels = {'claude-opus-5-5':'Opus 5.5', 'claude-fable-5-2':'Fable 5.2'};
export function routeMessage(text) {
  const original = String(text).trim();
  const match = original.match(/^@(claude|codex|minimax)(?=\s|[：:，,]|$)[\s：:，,]*/i);
  if (!match) return {target:'team', text:original};
  const target = match[1].toLowerCase(), task = original.slice(match[0].length).trim();
  if (!task) throw new Error('請在 @代理名稱 後輸入要處理的內容。');
  const role = {claude:'herdr-claude-task',codex:'herdr-codex-implement',minimax:'herdr-minimax-cn'}[target];
  return {target, text:`[Herdr 路由：指定 ${target}；單一代理任務。若目前總控就是指定代理，直接處理；否則透過 ${role} 派工並等待真實回報。不能以自己的答案代替。]\n${task}`};
}
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const validChat = id => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
const teamDir = c => c.teamDir || path.join(c.cwd, '.herdr-team');
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
export function selectedModel(c) {
  const value = read(path.join(teamDir(c), 'model.json'));
  return claudeModels[value?.model] ? value.model : 'claude-opus-5-5';
}
export async function switchModel(c, model, pause = delay) {
  if (!Object.hasOwn(claudeModels, model)) throw new Error('只能選擇 Opus 5.5 或 Fable 5.2。');
  const file = path.join(teamDir(c), 'model.json');
  const control = read(path.join(teamDir(c), 'control.json'));
  const label = claudeModels[model];
  if (control?.role !== 'claude' || !control.terminal) {
    save(file, {model, scope:'next_claude_session'});
    return {model, applied:false, message:`下次啟動 Claude 將使用 ${label}。`};
  }
  const id = control.terminal, t = c.run('hc', ['get', id]);
  if (t.state !== 'live' || !['claude-code','claude'].includes(t.status?.app)) throw new Error('Claude 尚未就緒，請先開啟總控。');
  if (!['idle','done'].includes(t.status?.state)) throw new Error(t.status?.state === 'blocked' ? 'Claude 正等待確認，請先處理提示，再切換模型。' : 'Claude 正在處理任務，請等這一回合結束再切換模型。');
  c.run('hc', ['send', id, `/model ${model}`]);
  let confirmed = false;
  for (let attempt=0; attempt<32; attempt++) {
    await pause(250);
    const screen = c.run('hc', ['read', id, '--json', '--lines', '0']).text || '';
    const marker = `/model ${model}`, at = screen.lastIndexOf(marker);
    if (at < 0) continue;
    const current = screen.slice(at + marker.length);
    if (current.includes(`Set model to ${label}`)) {
      save(file, {model, terminal:id, confirmedAt:new Date().toISOString()});
      log(c, '系統', `Claude 模型已切換為 ${label}。`, 'model');
      return {model, applied:true, message:`Claude 已切換為 ${label}。`};
    }
    // Only confirm the exact model-switch prompt requested by this button.
    // Permission, billing and any other dialog must remain for the user.
    if (!confirmed && current.includes('Switch model?') && current.includes(`❯ 1. Yes, switch to ${label}`) && /2\. No, go back\s*$/.test(current)) {
      c.run('hc', ['keys', id, 'enter']);
      confirmed = true;
    }
  }
  throw new Error('尚未收到模型切換成功的確認。請點「查看確認」查看 Claude 提示；目前選擇未標示為成功。');
}
export function context(cwd = process.cwd(), terminal = process.env.HC_TERMINAL_ID, run, chat = process.env.HERDR_TEAM_CHAT_ID || null) {
  if (chat && !validChat(chat)) throw new Error('Invalid conversation ID.');
  const root = path.resolve(cwd);
  return { cwd:root, chat, teamDir:path.join(root,'.herdr-team',...(chat ? ['conversations',chat] : [])), terminal, run: run || ((cmd, args) => JSON.parse(execFileSync(path.join(os.homedir(), '.local/bin', cmd), args, { cwd:root, encoding: 'utf8', timeout: 75000, maxBuffer: 1024 * 1024 }))) };
}
function paths(c) {
  const dir = teamDir(c);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { dir, control: path.join(dir, 'control.json'), lock: path.join(dir, 'takeover.lock'), messages: path.join(dir, 'messages.jsonl') };
}
export function log(c, role, text, kind = role === '你' ? 'user' : 'progress', extra = {}) {
  if (!String(text).trim()) return;
  const p = paths(c);
  fs.appendFileSync(p.messages, JSON.stringify({ ...extra, time: new Date().toISOString(), terminal: c.terminal || null, role: String(role).slice(0, 40), kind, text: String(text).slice(0, 12000) }) + '\n', { mode: 0o600 });
}
export function enqueueChat(c, text) {
  const original=String(text).trim(), routed=routeMessage(original);
  if (!original) throw new Error('請先輸入訊息。');
  const id=randomUUID(), dir=path.join(paths(c).dir,'chat-queue');
  save(path.join(dir,`${id}.json`),{id,original,...routed,createdAt:new Date().toISOString(),sequence:process.hrtime.bigint().toString().padStart(24,'0')});
  log(c,'你',original,'user',{messageId:id,delivery:'queued'});
  return {id,queued:true,target:routed.target};
}
function conversationContexts(c) {
  const root=path.join(c.cwd,'.herdr-team'), list=[{...c,chat:null,teamDir:root}];
  const dir=path.join(root,'conversations');
  if(fs.existsSync(dir)) for(const d of fs.readdirSync(dir,{withFileTypes:true})) if(d.isDirectory()&&validChat(d.name)) list.push({...c,chat:d.name,teamDir:path.join(dir,d.name)});
  return list;
}
export function drainChats(c) {
  const dir=path.join(teamDir(c),'chat-queue');
  if(!fs.existsSync(dir)) return {sent:0,pending:0};
  const files=fs.readdirSync(dir).filter(n=>/^[a-f0-9-]+\.json$/.test(n)).map(n=>({name:n,msg:read(path.join(dir,n))})).sort((a,b)=>(a.msg.sequence||a.msg.createdAt).localeCompare(b.msg.sequence||b.msg.createdAt)||a.name.localeCompare(b.name));
  if(!files.length) return {sent:0,pending:0};
  const lock=path.join(c.cwd,'.herdr-team/chat-delivery.lock');let fd;
  try{fd=fs.openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')return{sent:0,pending:files.length};throw e;}
  try {
    // A project shares files: do not start another conversation while one is busy.
    for(const other of conversationContexts(c)) {
      if(teamDir(other)===teamDir(c)) continue;
      const owner=read(path.join(teamDir(other),'control.json'));
      if(!owner?.terminal)continue;
      let t;try{t=c.run('hc',['get',owner.terminal]);}catch{continue;}
      if(t.state==='live' && ['working','blocked'].includes(t.status?.state))return{sent:0,pending:files.length,reason:'another_conversation_busy',blockingChat:other.chat,blockedTerminal:owner.terminal};
    }
    let control=read(path.join(teamDir(c),'control.json')), t=null;
    if(control?.terminal) {
      try{t=c.run('hc',['get',control.terminal]);}catch{return{sent:0,pending:files.length,reason:'coordinator_unavailable'};}
    }
    const foreground=t?.foreground?.argv || [];
    const shellWithoutAgent=foreground.length && /(?:^|\/)(?:zsh|bash|sh|fish|nu|pwsh)$/.test(foreground[0]) && !t?.status?.app;
    if(!t || t.state==='finished' || (shellWithoutAgent && Date.now()-(control.startedAt||0)>60000)) {
      const argv=[path.join(os.homedir(),'.local/bin/herdr-team-lead')];
      if(c.chat)argv.push('--team-chat',c.chat);
      if(control?.role==='claude' && /^[a-f0-9-]{36}$/.test(control.sessionId||''))argv.push('--resume',control.sessionId);
      const made=c.run('herdr-app',['do','space.new',JSON.stringify({name:path.basename(c.cwd),tab:'Claude · 對話總控',folder:c.cwd,argv,focus:false})]);
      if(!made.terminal)throw new Error('Herdr 沒有回傳總控。');
      const current=read(path.join(teamDir(c),'control.json'));
      if(current?.terminal!==made.terminal)save(path.join(teamDir(c),'control.json'),{...control,terminal:made.terminal,role:'claude',phase:'starting',startedAt:Date.now()});
      return{sent:0,pending:files.length,reason:'starting'};
    }
    if(!['claude-code','claude','codex'].includes(t.status?.app) || !['idle','done'].includes(t.status?.state))return{sent:0,pending:files.length,reason:t.status?.state||'starting'};
    // Avoid delivering a second queued message before the core reports the new turn.
    const leaseFile=path.join(c.cwd,'.herdr-team/chat-delivery.json'),lease=read(leaseFile);
    if(lease && Date.now()-lease.time<2500)return{sent:0,pending:files.length,reason:'awaiting_turn'};
    const {name,msg}=files[0];
    try {
      c.run('hc',['send',control.terminal,msg.text]);
      save(leaseFile,{terminal:control.terminal,time:Date.now()});
      fs.renameSync(path.join(dir,name),path.join(dir,name+'.sent'));
      log(c,'系統','訊息已送到總控。','delivery',{messageId:msg.id,delivery:'sent'});
      return{sent:1,pending:files.length-1};
    } catch {
      return{sent:0,pending:files.length,reason:'delivery_paused'};
    }
  }finally{fs.closeSync(fd);fs.unlinkSync(lock);}
}
export function drainProject(c) {
  return conversationContexts(c).filter(x=>fs.existsSync(teamDir(x))).map(x=>({chat:x.chat,...drain(x),chatQueue:drainChats(x)}));
}
export function captureReply(event, c, role) {
  const isClaude = role === 'Claude' && event.hook_event_name === 'Stop';
  const isCodex = role === 'Codex' && event.type === 'agent-turn-complete';
  if (!isClaude && !isCodex) return {captured: false};
  const control = read(path.join(teamDir(c), 'control.json'));
  if (control?.terminal && control.terminal !== c.terminal) return {captured: false, reason: 'not_active_coordinator'};
  const text = isClaude ? event.last_assistant_message : event['last-assistant-message'];
  if (typeof text !== 'string' || !text.trim()) return {captured:false};
  if(isClaude && control && /^[a-f0-9-]{36}$/.test(event.session_id||'')) save(path.join(teamDir(c),'control.json'),{...control,sessionId:event.session_id});
  log(c, role, text, 'reply');
  return {captured:true};
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
  const dir = path.join(teamDir(c), 'outbox');
  if (!fs.existsSync(dir)) return { delivered: 0, errors: [], requestsProcessed };
  let delivered = 0;
  const errors = [];
  for (const name of fs.readdirSync(dir).filter(x => /^[a-f0-9-]+\.json$/.test(x))) {
    const file = path.join(dir, name), pending = file + '.sending';
    try { fs.renameSync(file, pending); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    try {
      const msg = read(pending);
      if (!/^t[a-z0-9]+$/.test(msg.target || '') || typeof msg.text !== 'string') throw new Error('Invalid queued report.');
      const control = read(path.join(teamDir(c), 'control.json'));
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
  const control = read(path.join(teamDir(c), 'control.json'));
  if (!control?.terminal || req.sender !== control.terminal) throw new Error('Only the active coordinator may request operations.');
  const a = req.args || {};
  if (req.action === 'templates') return c.run('hc', ['templates']);
  if (req.action === 'list') {
    const all = c.run('hc', ['ls', '--json']);
    const owners = [control.terminal, control.previousTerminal].filter(Boolean);
    return {terminals: (Array.isArray(all) ? all : all.terminals || []).filter(t => owners.includes(t.parent) || owners.includes(t.address || t.id || t.terminal))};
  }
  if (req.action === 'run') {
    if (!['herdr-codex-implement', 'herdr-minimax-cn', 'herdr-claude-task'].includes(a.template)) throw new Error('Unknown worker template.');
    if (!/^[a-z0-9_-]{1,32}$/.test(a.name || '') || typeof a.task !== 'string' || !a.task.trim()) throw new Error('A valid worker name and task are required.');
    const root = fs.realpathSync(c.cwd), cwd = fs.realpathSync(path.resolve(c.cwd, a.cwd || '.'));
    if (cwd !== root && !cwd.startsWith(root + path.sep)) throw new Error('Worker cwd must remain inside this project.');
    const task=c.chat ? `本對話回報須使用 herdr-team-runtime --chat ${c.chat} report ${control.terminal} <角色> <摘要>；交接資料在 .herdr-team/conversations/${c.chat}/。\n${a.task}` : a.task;
    return c.run('hc', ['run', '--bg', '--name', a.name, '--cwd', cwd, '--parent', control.terminal, a.template, task]);
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
  const dir = path.join(teamDir(c), 'requests');
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const name of fs.readdirSync(dir).filter(x => /^[a-f0-9-]+\.json$/.test(x))) {
    const file = path.join(dir, name), pending = file + '.running';
    try { fs.renameSync(file, pending); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const req = read(pending);
    let response;
    try { response = {ok: true, result: executeRequest(c, req)}; }
    catch (error) { response = {ok: false, error: String(error.message)}; }
    save(path.join(teamDir(c), 'responses', name), response);
    fs.renameSync(pending, file + '.done');
    count++;
  }
  return count;
}
async function response(c, id) {
  if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('Invalid request ID.');
  const dir = path.join(teamDir(c), 'responses'), file = path.join(dir, `${id}.json`);
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
    if(c.chat)args.argv.splice(1,0,'--team-chat',c.chat);
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
  return { hooks: { Stop: [{hooks: [{type:'command',command:`${quote(node)} ${quote(runtime)} reply`,timeout:10}]}], StopFailure: [{ matcher: [...recoverable].join('|'), hooks: [{ type: 'command', command: `${quote(node)} ${quote(runtime)} hook`, timeout: 20 }] }] } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const argv=process.argv.slice(2);
    if(argv[0]==='--chat') {const id=argv[1];if(!id||!validChat(id))throw new Error('Invalid conversation ID.');process.env.HERDR_TEAM_CHAT_ID=id;argv.splice(0,2);}
    const [cmd, ...args] = argv;
    let result;
    if (['help', '--help', '-h'].includes(cmd)) result = { usage: 'herdr-team-runtime register claude|codex; report <coordinator-id> <role> <summary>; request <action> <json>; response <id>; log <role> <summary>; drain; takeover <project>' };
    else if (cmd === 'hook') {
      const event = JSON.parse(fs.readFileSync(0, 'utf8'));
      result = handleFailure(event, context(event.cwd || process.cwd()));
    } else if (cmd === 'reply') {
      const event = JSON.parse(fs.readFileSync(0,'utf8'));
      result = captureReply(event, context(event.cwd || process.cwd()), 'Claude');
    } else if (cmd === 'codex-notify') {
      const event = JSON.parse(args[0] || '{}');
      result = captureReply(event, context(event.cwd || process.cwd()), 'Codex');
    } else if (cmd === 'model-id') { process.stdout.write(selectedModel(context()) + '\n'); result = null; }
    else if (cmd === 'switch-model') result = await switchModel(context(), args[0]);
    else if (cmd === 'route') result = routeMessage(args[0] || '');
    else if (cmd === 'enqueue') result = enqueueChat(context(),args[0]||'');
    else if (cmd === 'drain-project') result = drainProject(context());
    else if (cmd === 'prompt') {let prompt=fs.readFileSync(0,'utf8');const c=context();if(c.chat)prompt=prompt.replaceAll('.herdr-team/',`.herdr-team/conversations/${c.chat}/`).replaceAll('herdr-team-runtime ',`herdr-team-runtime --chat ${c.chat} `);process.stdout.write(prompt);result=null;}
    else if (cmd === 'register') result = register(context(), args[0]);
    else if (cmd === 'takeover') result = takeover(context(args[0] || process.cwd(), null), 'user_requested', false);
    else if (cmd === 'log') result = log(context(), args[0], args.slice(1).join(' '));
    else if (cmd === 'report') result = report(context(), args[0], args[1], args.slice(2).join(' '));
    else if (cmd === 'drain') result = drain(context());
    else if (cmd === 'request') result = request(context(), args[0], JSON.parse(args[1] || '{}'));
    else if (cmd === 'response') result = await response(context(), args[0]);
    else if (cmd === 'settings') result = hooksSettings(args[0], args[1]);
    else throw new Error('Unknown runtime command');
    if (!['hook','reply','codex-notify','model-id','prompt'].includes(cmd)) process.stdout.write(JSON.stringify(result ?? { ok: true }) + '\n');
  } catch (error) { console.error(`Herdr team: ${error.message}`); process.exitCode = 1; }
}
