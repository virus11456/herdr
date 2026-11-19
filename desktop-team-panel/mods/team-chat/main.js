import { View, div } from 'gpui-kit';
import { v_flex, h_flex, TextareaState, Textarea, Button, TextView } from 'gpui-base';
import { theme, home, appHome, checking, shared, setShared, focused, terminals, exec, hc, readTextFile, writeTextFile, pickFolder, run, updates } from 'herdr';

const stateKey = 'team-chat.workspace';
const statusName = s => ({ working: '處理中', blocked: '需要你確認', idle: '待命', done: '回合結束', error: '發生錯誤' }[s] || '尚未回報狀態');

export default class TeamChat extends View {
  init(_props, cx) {
    this.input = TextareaState.new({ placeholder: '描述目標、限制與完成條件…', rows: 4 });
    this.input.on('submit', (e, cx) => { if (e.secondary) this.send(cx); });
    this.input.on('focus', (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on('blur', (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.busy = false; this.error = ''; this.events = []; this.status = ''; this.result = ''; this.control = null;
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(4000, cx => this.refresh(cx));
  }
  workspace() { return shared(stateKey) || {}; }
  operation(cx, fn) {
    if (this.busy) return;
    this.busy = true; this.error = ''; cx.notify();
    cx.spawn(async cx => {
      try { await fn(); } catch (e) { this.error = String(e.message || e); }
      finally { this.busy = false; cx.notify(); }
    });
  }
  refresh(cx) {
    if (this.refreshing || checking()) return;
    this.refreshing = true;
    cx.spawn(async cx => {
      try {
        const updateText = JSON.stringify(updates(), null, 2);
        if (updateText !== this.updateSnapshot) {
          const updateFile = `${appHome()}/team-updates.json`;
          const before = await readTextFile(updateFile);
          await writeTextFile(updateFile, updateText, before);
          this.updateSnapshot = updateText;
        }
        if (!this.workspace().folder) {
          const initial = await readTextFile(`${appHome()}/team-chat.json`);
          if (initial) setShared(stateKey, JSON.parse(initial));
        }
        const w = this.workspace();
        if (!w.folder) return;
        const delivery = await exec(`${home()}/.local/bin/herdr-team-runtime`, ['drain'], {cwd: w.folder, timeout: 90000});
        if (delivery.code !== 0) throw new Error(delivery.stderr || '回報轉送失敗');
        const dir = `${w.folder}/.herdr-team`;
        const [control, status, messages, result, review] = await Promise.all(['control.json', 'STATUS.md', 'messages.jsonl', '../RESULT.md', '../REVIEW.md'].map(name => readTextFile(`${dir}/${name}`)));
        const next = JSON.stringify([control, status, messages, result, review]);
        if (next !== this.snapshot) {
          this.snapshot = next; this.control = control ? JSON.parse(control) : null;
          this.status = status || ''; this.result = result || review || '';
          this.events = (messages || '').split('\n').filter(Boolean).slice(-35).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
          cx.notify();
        }
      } catch (e) { if (!this.error) { this.error = `讀取紀錄失敗：${e.message || e}`; cx.notify(); } }
      finally { this.refreshing = false; }
    });
  }
  choose(cx) {
    this.operation(cx, async () => {
      const folder = await pickFolder({ prompt: '選擇協作專案' });
      if (folder) { setShared(stateKey, { folder }); this.snapshot = null; this.events = []; this.status = ''; this.result = ''; this.control = null; }
    });
  }
  async log(role, text) {
    const w = this.workspace();
    const r = await exec(`${home()}/.local/bin/herdr-team-runtime`, ['log', role, text], { cwd: w.folder });
    if (r.code !== 0) throw new Error(r.stderr || '無法保存訊息');
  }
  send(cx) {
    const text = this.input.value().trim();
    if (!text) { this.error = '請先輸入任務內容。'; cx.notify(); return; }
    const w = this.workspace();
    if (!w.folder) { this.error = '請先選擇專案資料夾。'; cx.notify(); return; }
    this.operation(cx, async () => {
      let id = this.control?.terminal || w.terminal;
      if (id) {
        const check = await hc(['get', id]);
        if (check.code !== 0) throw new Error(check.stderr || check.stdout || '無法確認總控狀態，訊息未送出。');
        const terminal = JSON.parse(check.stdout);
        const argv = terminal.foreground?.argv || [];
        const shell = argv.length && /(?:^|\/)(?:zsh|bash|sh|fish|nu|pwsh)$/.test(argv[0]);
        if (terminal.state === 'finished' || (shell && !terminal.status?.app)) id = null;
        else if (!['claude-code', 'claude', 'codex'].includes(terminal.status?.app)) throw new Error('總控尚未就緒。請開啟總控，先完成登入或啟動提示。');
      }
      if (id) {
        const r = await hc(['send', id, text]);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || '訊息未送出，請開啟終端查看。');
      } else {
        const args = { name: 'Claude · 總控', folder: w.folder, argv: [`${home()}/.local/bin/herdr-team-lead`, text] };
        if (w.space || focused()?.space) args.space = w.space || focused().space;
        const r = await exec(`${home()}/.local/bin/herdr-app`, ['do', 'tab.new', JSON.stringify(args)]);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || '無法啟動總控');
        const made = JSON.parse(r.stdout);
        if (!made.terminal) throw new Error(made.error || 'Herdr 沒有回傳終端');
        setShared(stateKey, { ...w, ...made });
      }
      await this.log('你', text);
      this.input.set_value('');
    });
  }
  backup(cx) {
    const w = this.workspace();
    if (!w.folder) { this.error = '請先選擇專案資料夾。'; cx.notify(); return; }
    this.operation(cx, async () => {
      const r = await exec(`${home()}/.local/bin/herdr-team-runtime`, ['takeover', w.folder], { cwd: w.folder });
      if (r.code !== 0) throw new Error(r.stderr || '無法切換，請查看目前總控終端。');
      const answer = JSON.parse(r.stdout);
      if (!answer.switched) throw new Error(answer.reason === 'not_active_claude' ? '目前沒有可接手的 Claude 總控，或已由 Codex 總控處理。' : '正在切換，請稍候。');
      setShared(stateKey, { ...w, terminal: answer.terminal });
    });
  }
  open() {
    const id = this.control?.terminal || this.workspace().terminal;
    if (id) run('terminal.peek', { terminal: id });
  }
  render() {
    const t = theme(), w = this.workspace(), id = this.control?.terminal || w.terminal;
    const lead = terminals().find(x => (x.address || x.id || x.terminal) === id);
    const state = typeof lead?.status === 'object' ? lead.status?.state : lead?.status;
    const workers = terminals().filter(x => x.parent === id);
    const workerStatus = name => {
      const worker = workers.find(x => String(x.status?.app || x.app || '').includes(name));
      return worker ? ` · ${statusName(typeof worker.status === 'object' ? worker.status.state : worker.status)}` : '';
    };
    const waiting = workers.some(x => (typeof x.status === 'object' ? x.status.state : x.status) === 'blocked');
    const active = this.control?.role === 'codex' ? 'Codex 備援總控' : 'Claude 主總控';
    const button = (id, label, fn, primary = false, disabled = this.busy) => Button.new(id).accessibility_label(label).h(38).px(12).rounded(8).border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).disabled(disabled).opacity(disabled ? 0.5 : 1).on_click((_e, cx) => fn(cx)).child(label);
    const section = text => div().text_size(12).font_semibold().text_color(t.foreground).child(text);
    const card = (name, description) => h_flex().w_full().p(10).gap(10).rounded(8).bg(t.raised).child(div().w(94).font_medium().child(name)).child(div().flex_1().text_color(t.muted).child(description));
    const u = updates();
    const version = u.checking ? '正在檢查更新' : u.checked ? (u.app.ready || u.core.ready ? '有更新可用' : '更新檢查完成') : '尚未確認最新版本';
    return v_flex().id('team-chat').track_focus(this.handle).size_full().min_h(0).bg(t.surface).text_color(t.foreground).text_size(13)
      .child(v_flex().p(16).gap(12)
        .child(h_flex().items_center().child(div().flex_1().text_size(17).font_semibold().child('協作對話'))
          .child(div().text_size(11).text_color(t.muted).child(this.busy ? '處理中…' : waiting ? '工作代理需要確認' : statusName(state))))
        .child(div().text_color(t.muted).child('交代目標，由總控派工並整合回報。'))
        .child(section('專案資料夾'))
        .child(div().text_size(11.5).text_color(t.muted).child(w.folder || '尚未選擇'))
        .child(button('team-folder', '選擇專案', cx => this.choose(cx)))
        .child(v_flex().gap(6).text_size(12).child(card(active, '拆解 · 派工 · 整合')).child(card('Codex', `實作${workerStatus('codex')}`)).child(card('MiniMax CN', `測試與審查${workerStatus('mcode')}`)))
        .child(section('你的任務'))
        .child(Textarea.new(this.input).accessibility_label('你的任務').h(112).w_full().p(10).rounded(8).bg(t.background).border_1().border_color(this.inputFocused ? t.accent : t.input).text_color(t.foreground).text_size(13))
        .child(h_flex().gap(8).child(button('team-send', this.busy ? '送出中…' : '送給總控', cx => this.send(cx), true)).child(button('team-open', '開啟總控', () => this.open(), false, !id || this.busy)))
        .child(button('team-backup', '切換至 Codex 備援總控', cx => this.backup(cx), false, !id || this.busy || this.control?.role === 'codex'))
        .when(Boolean(this.error), el => el.child(div().p(10).rounded(8).bg(t.background).text_color(t.blocked).child(this.error)))
        .child(section('協作紀錄')))
      .child(v_flex().id('team-log').flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(16).gap(12)
        .when(!this.events.length && !this.status, el => el.child(div().text_color(t.muted).child('派工、回報和交接紀錄會顯示在這裡。完整代理輸出可從終端查看。')))
        .children(this.events.map((m, i) => v_flex().id(`team-message-${i}`).p(10).gap(6).rounded(8).bg(t.background)
          .child(div().text_size(11).font_semibold().text_color(t.muted).child(`${m.role}${m.terminal ? ` · ${m.terminal}` : ''} · ${String(m.time || '').slice(11, 19)} UTC`))
          .child(TextView.markdown(`team-message-text-${i}`, m.text || '').w_full().text_size(12.5))))
        .when(Boolean(this.status), el => el.child(section('總控進度紀錄')).child(TextView.markdown('team-status', this.status).w_full().text_size(12.5)))
        .when(Boolean(this.result), el => el.child(section('驗證與結果')).child(TextView.markdown('team-result', this.result).w_full().text_size(12.5))))
      .child(v_flex().px(16).py(10).gap(4).border_t_1().border_color(t.border).text_size(10.5).text_color(t.muted)
        .child(div().child(`Herdr ${u.app.version} · Core ${u.core.version || '未知'} · ${version}`))
        .child(div().child('額度與服務錯誤由 Claude 官方 hook 觸發備援；權限確認由你決定。')));
  }
}
