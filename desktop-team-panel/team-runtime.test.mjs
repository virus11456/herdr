import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { context, register, handleFailure, takeover, hooksSettings, report, drain, request, executeRequest, drainRequests } from './team-runtime.mjs';

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
