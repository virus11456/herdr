import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, register, handleFailure, takeover, hooksSettings, report, drain, request, executeRequest, drainRequests, captureReply, routeMessage, switchModel, selectedModel, enqueueChat, drainChats, drainProject } from './team-runtime.mjs';

function fixture(t, state = 'idle') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-team-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  const c = context(cwd, 't10', (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'hc' && args[0] === 'get') return { state: 'live', status: { app: 'claude-code', state, ...(state === 'blocked' ? {kind: 'permission'} : {}) }, labels: { 'herdr.space': 'sp1' } };
    if (cmd === 'hc') return {};
    return { terminal: 't20', tab: 'tab20' };
  });
  register(c, 'claude');
  return { c, calls, cwd };
}
test('API rate limit switches once and preserves project/space without shell interpolation', t => {
  const { c, calls, cwd } = fixture(t, 'error');
  assert.equal(handleFailure({ hook_event_name: 'StopFailure', error: 'rate_limit' }, c).switched, true);
  assert.equal(handleFailure({ hook_event_name: 'StopFailure', error: 'rate_limit' }, c).switched, false);
  const created = calls.filter(([cmd]) => cmd === 'herdr-app');
  assert.equal(created.length, 1);
  const payload = JSON.parse(created[0][1][2]);
  assert.equal(payload.folder, cwd);
  assert.equal(payload.space, 'sp1');
  assert.equal(fs.existsSync(path.join(cwd, '.herdr-team/takeover.lock')), false);
});
test('permission prompts, normal stops and output limits never trigger fallback', t => {
  const { c, calls } = fixture(t);
  for (const event of [{ hook_event_name: 'Stop', error: 'rate_limit' }, { hook_event_name: 'StopFailure', error: 'permission_denied' }, { hook_event_name: 'StopFailure', error: 'max_output_tokens' }]) assert.equal(handleFailure(event, c).switched, false);
  assert.equal(calls.filter(([cmd]) => cmd === 'herdr-app').length, 0);
});
test('blocked user decisions are preserved even for a recoverable error', t => {
  const { c, calls } = fixture(t, 'blocked');
  assert.throws(() => handleFailure({ hook_event_name: 'StopFailure', error: 'server_error' }, c), /user or permission/);
  assert.equal(calls.filter(([cmd]) => cmd === 'herdr-app').length, 0);
});
test('manual takeover refuses to start while old coordinator still works', t => {
  const { c, calls } = fixture(t, 'working');
  assert.throws(() => takeover(c, 'user_requested'), /has not stopped/);
  assert.equal(calls.filter(([cmd]) => cmd === 'herdr-app').length, 0);
});
test('failed launch restores ownership and releases the transition lock', t => {
  const { c, cwd } = fixture(t, 'error');
  const run = c.run;
  c.run = (cmd, args) => { if (cmd === 'herdr-app') throw new Error('unreachable'); return run(cmd, args); };
  assert.throws(() => handleFailure({ hook_event_name: 'StopFailure', error: 'rate_limit' }, c), /unreachable/);
  const control = JSON.parse(fs.readFileSync(path.join(cwd, '.herdr-team/control.json')));
  assert.equal(control.terminal, 't10');
  assert.equal(control.phase, 'handoff_failed');
  assert.equal(fs.existsSync(path.join(cwd, '.herdr-team/takeover.lock')), false);
});
test('hook command quotes spaces and apostrophes in install paths', () => {
  const settings = hooksSettings("/a b/it's.mjs", '/node path/node');
  assert.match(settings.hooks.StopFailure[0].hooks[0].command, /'\\''/);
  assert.ok(settings.hooks.StopFailure[0].matcher.includes('rate_limit'));
});
test('sandboxed worker writes a report without accessing hc; host delivers once', t => {
  const { c, calls } = fixture(t);
  report(c, 't10', 'Codex', 'Implementation finished; real artifact: todo.mjs');
  assert.equal(calls.length, 0);
  assert.equal(drain(c).delivered, 1);
  assert.equal(drain(c).delivered, 0);
  assert.equal(calls[0][0], 'hc');
  assert.deepEqual(calls[0][1].slice(0, 2), ['send', 't10']);
});
test('blocked report delivery stays queued instead of using force', t => {
  const { c } = fixture(t);
  report(c, 't10', 'Codex', 'Report');
  c.run = () => { throw new Error('permission decision pending'); };
  const result = drain(c);
  assert.equal(result.delivered, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(fs.readdirSync(path.join(c.cwd, '.herdr-team/outbox')).filter(x => x.endsWith('.json')).length, 1);
});
test('report recipients cannot be command line switches or remote targets', t => {
  const { c } = fixture(t);
  assert.throws(() => report(c, '--force', 'Codex', 'x'), /terminal ID/);
  assert.throws(() => report(c, 'remote/t1', 'Codex', 'x'), /terminal ID/);
});
test('a second live coordinator cannot register over the active one', t => {
  const { c, cwd } = fixture(t, 'idle');
  assert.throws(() => register({...c, terminal: 't99'}, 'claude'), /already has a coordinator/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.herdr-team/control.json'))).terminal, 't10');
});
test('registration lock protects simultaneous starts', t => {
  const { c, cwd } = fixture(t);
  fs.writeFileSync(path.join(cwd, '.herdr-team/register.lock'), '');
  assert.throws(() => register({...c, terminal: 't99'}, 'claude'), /being registered/);
});
test('simulation is labelled and only requests a read-only handover exercise', t => {
  const { c, calls } = fixture(t, 'done');
  assert.equal(handleFailure({hook_event_name:'StopFailure', error:'rate_limit', simulated:true}, c).reason, 'simulated_rate_limit');
  const payload = JSON.parse(calls.find(([cmd]) => cmd === 'herdr-app')[1][2]);
  assert.match(payload.argv[1], /不是 Claude 真正耗盡額度/);
  assert.match(payload.argv[1], /不要啟動其他代理/);
});
test('sandboxed coordinator request is performed by host and records a response', t => {
  const {c, calls, cwd} = fixture(t);
  const req = request(c, 'templates', {});
  assert.equal(calls.length, 0);
  assert.equal(drainRequests(c), 1);
  assert.equal(JSON.parse(fs.readFileSync(req.response)).ok, true);
  assert.deepEqual(calls[0], ['hc', ['templates']]);
  assert.equal(drainRequests(c), 0);
});
test('only active coordinator can dispatch', t => {
  const {c} = fixture(t);
  assert.throws(() => executeRequest(c, {sender:'t99', action:'templates'}), /active coordinator/);
});
test('run broker permits known templates and explicitly sets team parent', t => {
  const {c, calls} = fixture(t);
  executeRequest(c, {sender:'t10', action:'run', args:{template:'herdr-codex-implement', name:'impl', task:'Do assigned work'}});
  const args = calls[0][1];
  assert.equal(args[args.indexOf('--parent') + 1], 't10');
  assert.ok(args.includes('--bg'));
});
test('broker rejects arbitrary programs and cwd outside project', t => {
  const {c} = fixture(t);
  assert.throws(() => executeRequest(c, {sender:'t10', action:'run', args:{template:'sh', name:'x', task:'x'}}), /template/);
  assert.throws(() => executeRequest(c, {sender:'t10', action:'run', args:{template:'herdr-codex-implement', name:'x', task:'x', cwd:'..'}}), /inside this project/);
});
test('broker cannot operate on unrelated user terminals', t => {
  const {c} = fixture(t);
  assert.throws(() => executeRequest(c, {sender:'t10', action:'send', args:{terminal:'t99', text:'x'}}), /does not belong/);
});
test('team list includes its leader and workers but excludes unrelated root terminals', t => {
  const {c} = fixture(t);
  c.run = () => ({terminals:[{terminal:'t10', parent:null}, {terminal:'t11', parent:'t10'}, {terminal:'t99', parent:null}]});
  assert.deepEqual(executeRequest(c, {sender:'t10', action:'list'}).terminals.map(t=>t.terminal), ['t10','t11']);
});
test('worker reports to the former leader follow a completed handover', t => {
  const {c, cwd, calls} = fixture(t);
  report(c, 't10', 'Codex', 'Finished existing work');
  fs.writeFileSync(path.join(cwd, '.herdr-team/control.json'), JSON.stringify({terminal:'t20',role:'codex',previousTerminal:'t10'}));
  assert.equal(drain(c).delivered, 1);
  assert.deepEqual(calls[0][1].slice(0,2), ['send','t20']);
  assert.match(calls[0][1][2], /forwarded from t10/);
});
test('Claude final reply is copied exactly without input or hidden fields', t => {
  const {c,cwd}=fixture(t);
  const text='這是繁體中文回覆。';
  assert.equal(captureReply({hook_event_name:'Stop',last_assistant_message:text,input:'private-input',thinking:'hidden'},c,'Claude').captured,true);
  const all=fs.readFileSync(path.join(cwd,'.herdr-team/messages.jsonl'),'utf8');
  const last=JSON.parse(all.trim().split('\n').at(-1));
  assert.equal(last.text,text);assert.equal(last.kind,'reply');
  assert.ok(!all.includes('private-input'));assert.ok(!all.includes('hidden'));
});
test('Codex notify captures completed replies and rejects unrelated events or old leaders', t => {
  const {c}=fixture(t);
  assert.equal(captureReply({type:'agent-turn-complete','last-assistant-message':'已完成'},c,'Codex').captured,true);
  assert.equal(captureReply({type:'other','last-assistant-message':'x'},c,'Codex').captured,false);
  assert.equal(captureReply({hook_event_name:'Stop',last_assistant_message:'x'},{...c,terminal:'t99'},'Claude').captured,false);
});
test('mentions route only an explicit leading agent name and preserve the task', () => {
  assert.equal(routeMessage('請找 @codex 的紀錄').target,'team');
  assert.equal(routeMessage('@codextra test').target,'team');
  assert.equal(routeMessage('@Codex：修好中文輸入').target,'codex');
  assert.match(routeMessage('@minimax 測試此檔案').text,/herdr-minimax-cn/);
  assert.match(routeMessage('@claude 說明問題').text,/說明問題$/);
  assert.throws(()=>routeMessage('@codex'),/輸入/);
});
test('model switch only confirms the exact requested model dialog and waits for success', async t => {
  const {c,cwd,calls}=fixture(t);
  const run=c.run;let reads=0;
  c.run=(cmd,args)=>{
    if(args[0]==='read') return {text:++reads===1?'/model claude-opus-5-5\nSwitch model?\n❯ 1. Yes, switch to Opus 5.5\n  2. No, go back':'/model claude-opus-5-5\nSet model to Opus 5.5 and saved as your default for new sessions'};
    return run(cmd,args);
  };
  assert.equal((await switchModel(c,'claude-opus-5-5',async()=>{})).applied,true);
  assert.equal(calls.filter(([,a])=>a[0]==='keys').length,1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd,'.herdr-team/model.json'))).terminal,'t10');
});
test('model selection does not interrupt work or answer permission prompts', async t => {
  for(const state of ['working','blocked']) {
    const {c,calls,cwd}=fixture(t,state);
    await assert.rejects(switchModel(c,'claude-fable-5-2',async()=>{}),/處理|確認/);
    assert.ok(!calls.some(([,a])=>['send','keys'].includes(a[0])));
    assert.equal(fs.existsSync(path.join(cwd,'.herdr-team/model.json')),false);
  }
});
test('old successful switches and unrelated dialogs cannot be reported as a new success', async t => {
  const {c,calls,cwd}=fixture(t), run=c.run;
  c.run=(cmd,args)=>args[0]==='read'?{text:'/model claude-fable-5-2\nSet model to Fable 5.2\n/model claude-fable-5-2\nAllow reading?\n❯ 1. Yes\n2. No'}:run(cmd,args);
  await assert.rejects(switchModel(c,'claude-fable-5-2',async()=>{}),/尚未收到/);
  assert.ok(!calls.some(([,a])=>a[0]==='keys'));
  assert.equal(fs.existsSync(path.join(cwd,'.herdr-team/model.json')),false);
});
test('future Claude preference survives backup mode and rejects arbitrary model input', async t => {
  const {c,cwd,calls}=fixture(t);
  fs.writeFileSync(path.join(cwd,'.herdr-team/control.json'),JSON.stringify({terminal:'t20',role:'codex'}));
  assert.equal((await switchModel(c,'claude-fable-5-2')).applied,false);
  assert.equal(selectedModel(c),'claude-fable-5-2');
  assert.equal(calls.length,0);
  await assert.rejects(switchModel(c,'invalid\n/permission'),/只能/);
});
test('consecutive messages save immediately while working and later deliver in order', t=>{
  const {c,cwd,calls}=fixture(t,'working');
  enqueueChat(c,'第一則');enqueueChat(c,'第二則');
  assert.equal(drainChats(c).pending,2);assert.ok(!calls.some(([,a])=>a[0]==='send'));
  const run=c.run;c.run=(cmd,a)=>a[0]==='get'?{state:'live',status:{app:'claude-code',state:'done'}}:run(cmd,a);
  assert.equal(drainChats(c).sent,1);assert.equal(calls.find(([,a])=>a[0]==='send')[1][2],'第一則');
  assert.equal(drainChats(c).sent,0);
  fs.unlinkSync(path.join(cwd,'.herdr-team/chat-delivery.json'));
  assert.equal(drainChats(c).sent,1);assert.equal(calls.filter(([,a])=>a[0]==='send').at(-1)[1][2],'第二則');
});
test('queued messages never answer a permission dialog or disappear on send failure',t=>{
  const {c,calls}=fixture(t,'blocked');enqueueChat(c,'等確認後處理');
  assert.equal(drainChats(c).reason,'blocked');assert.ok(!calls.some(([,a])=>a.includes('--force')||a[0]==='send'));
  c.run=(cmd,a)=>{if(a[0]==='get')return{state:'live',status:{app:'claude-code',state:'idle'}};throw Error('permission race');};
  assert.equal(drainChats(c).reason,'delivery_paused');assert.equal(drainChats(c).pending,1);
});
test('new conversations isolate messages, models, ownership and replies',t=>{
  const {c,cwd}=fixture(t), first=context(cwd,'t21',c.run,'chat-one'), second=context(cwd,'t22',c.run,'chat-two');
  register(first,'claude');register(second,'claude');
  enqueueChat(first,'只在第一個對話');captureReply({hook_event_name:'Stop',last_assistant_message:'第一個答案'},first,'Claude');
  fs.writeFileSync(path.join(first.teamDir,'model.json'),JSON.stringify({model:'claude-fable-5-2'}));
  assert.equal(selectedModel(first),'claude-fable-5-2');assert.equal(selectedModel(second),'claude-opus-5-5');
  assert.equal(fs.existsSync(path.join(second.teamDir,'messages.jsonl')),true); // registration only
  assert.ok(!fs.readFileSync(path.join(second.teamDir,'messages.jsonl'),'utf8').includes('第一個'));
  assert.throws(()=>context(cwd,'t1',c.run,'../escape'),/Invalid conversation/);
});
test('named conversation dispatch and backup keep their report and hook scope',t=>{
  const {c,cwd,calls}=fixture(t,'error'),chat=context(cwd,'t25',c.run,'scoped-chat');register(chat,'claude');
  executeRequest(chat,{sender:'t25',action:'run',args:{template:'herdr-minimax-cn',name:'check',task:'Review only'}});
  assert.match(calls.find(([,a])=>a[0]==='run')[1].at(-1),/--chat scoped-chat report t25/);
  assert.equal(handleFailure({hook_event_name:'StopFailure',error:'rate_limit'},chat).switched,true);
  const args=JSON.parse(calls.find(([cmd])=>cmd==='herdr-app')[1][2]).argv;
  assert.deepEqual(args.slice(1,3),['--team-chat','scoped-chat']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cwd,'.herdr-team/control.json'))).terminal,'t10');
});
test('busy conversations prevent another chat from editing the same project',t=>{
  const {c,cwd,calls}=fixture(t,'working'), chat=context(cwd,'t21',c.run,'another');
  register(chat,'claude');enqueueChat(chat,'新的工作');
  assert.equal(drainChats(chat).reason,'another_conversation_busy');
  assert.ok(!calls.some(([,a])=>a[0]==='send'));
});
test('a new chat starts one coordinator and preserves the queued first message',t=>{
  const {c,cwd}=fixture(t);let starts=0;
  const chat=context(cwd,null,(cmd,a)=>cmd==='hc'?{state:'live',status:null}:(starts++,{terminal:'t30'}),'new-chat');
  enqueueChat(chat,'第一則獨立對話');
  // Remove the unrelated fixture owner so this conversation may start.
  fs.unlinkSync(path.join(cwd,'.herdr-team/control.json'));
  assert.equal(drainChats(chat).reason,'starting');
  const control=JSON.parse(fs.readFileSync(path.join(chat.teamDir,'control.json')));
  assert.equal(control.terminal,'t30');assert.equal(drainChats(chat).pending,1);assert.equal(starts,1);
});
