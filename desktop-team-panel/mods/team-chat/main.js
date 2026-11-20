import { View, div } from 'gpui-kit';
import { v_flex, h_flex, TextareaState, Textarea, Button, TextView, ScrollHandle } from 'gpui-base';
import { theme, home, appHome, checking, shared, setShared, focused, terminals, exec, hc, readTextFile, writeTextFile, pickFolder, run, updates } from 'herdr';

const stateKey = 'team-chat.workspace';
const statusName = s => ({ working: '處理中', blocked: '需要你確認', idle: '待命', done: '回合結束', error: '發生錯誤' }[s] || '尚未回報狀態');
const terminalId = t => t?.address || t?.id || t?.terminal;
const terminalState = t => t?.status && typeof t.status === 'object' ? t.status.state : t?.status;
const agentName = t => ({'claude-code':'Claude',claude:'Claude',codex:'Codex',mcode:'MiniMax CN'}[t?.report?.app || t?.app || t?.status?.app] || t?.name || '代理');
const modelNames = {'claude-opus-5-5':'Opus 5.5','claude-fable-5-2':'Fable 5.2'};
function readableError(raw, fallback) {
  try {
    const e = JSON.parse(raw).error;
    if (e?.kind === 'blocked') return '代理正在等待權限或問題確認，訊息尚未送出。請點「查看確認」處理後再送出。';
    if (e?.message) return e.message;
  } catch {}
  return raw || fallback;
}

export default class TeamChat extends View {
  init(_props, cx) {
    this.input = TextareaState.new({ placeholder: '描述目標、限制與完成條件…', rows: 4 });
    this.input.on('submit', (e, cx) => { if (!e.shift || e.secondary) this.send(cx); });
    this.input.on('focus', (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on('blur', (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.input.on('change', () => {
      if (checking()) return;
      const drafts = {...(shared('team-chat.drafts') || {})};
      drafts[this.key(this.workspace())] = this.input.value(); setShared('team-chat.drafts',drafts);
    });
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.details = false; this.lastMessageCount = 0;
    this.busy = false; this.sending = 0; this.saveTail = Promise.resolve(); this.draining = {}; this.queueStatus = {}; this.error = ''; this.info = ''; this.events = []; this.status = ''; this.result = ''; this.control = null; this.modelInfo = null;
    if (checking()) return;
    this.input.set_value((shared('team-chat.drafts') || {})[this.key(this.workspace())] || '');
    if (!shared('team-chat.view-start')) setShared('team-chat.view-start', Date.now());
    this.refresh(cx);
    cx.timer.every(4000, cx => this.refresh(cx));
  }
  workspace() { return shared(stateKey) || {}; }
  projects() { return shared('team-chat.projects') || []; }
  args(w, command) { return w.chatId ? ['--chat',w.chatId,...command] : command; }
  key(w) { return `${w.folder || ''}:${w.chatId || 'legacy'}`; }
  remember(w) {
    if (!w.folder) return;
    const list = this.projects().slice();
    let p = list.find(x => x.folder === w.folder);
    if (!p) { p = {folder:w.folder,name:w.folder.split('/').filter(Boolean).pop(),chats:[]}; list.push(p); }
    const id = w.chatId || 'legacy';
    if (!p.chats.some(x => x.id === id)) p.chats.push({id,title:id === 'legacy' ? '原有對話' : '新對話',createdAt:Date.now()});
    setShared('team-chat.projects',list);
  }
  select(w, cx) {
    const drafts = {...(shared('team-chat.drafts') || {})};
    drafts[this.key(this.workspace())] = this.input.value();
    setShared('team-chat.drafts',drafts);
    this.remember(w); setShared(stateKey,w);
    this.input.set_value(drafts[this.key(w)] || ''); this.input.focus();
    this.snapshot = null; this.events = []; this.control = null; this.modelInfo = null; this.status = ''; this.result = ''; this.error = ''; this.info = ''; this.details = false; this.lastMessageCount = 0;
    cx.notify(); this.refresh(cx);
  }
  newChat(cx, folder = this.workspace().folder) {
    if (!folder) { this.choose(cx); return; }
    const chatId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,10)}`;
    this.select({folder,chatId},cx);
  }
  removeProject(folder,cx) {
    const list=this.projects().filter(p=>p.folder!==folder);
    setShared('team-chat.projects',list);
    if(this.workspace().folder===folder) {
      const p=list[0], chat=p?.chats.slice(-1)[0];
      this.select(p?{folder:p.folder,...(chat?.id&&chat.id!=='legacy'?{chatId:chat.id}:{})}:{},cx);
    }
    cx.notify();
  }
  operation(cx, fn) {
    if (this.busy) return;
    this.busy = true; this.error = ''; this.info = ''; cx.notify();
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
        const initialText = await readTextFile(`${appHome()}/team-chat.json`);
        if (initialText) {
          const initial = JSON.parse(initialText);
          if (!this.workspace().folder || (initial.requestId && initial.requestId !== shared('team-chat.initial-id'))) {
            const changed = this.workspace().folder !== initial.folder;
            setShared(stateKey, initial);
            if (initial.requestId) setShared('team-chat.initial-id', initial.requestId);
            if (changed) setShared('team-chat.view-start', Date.now());
            this.snapshot = null;
          }
        }
        const w = this.workspace();
        if (!w.folder) return;
        if (!this.projects().some(p => p.folder === w.folder)) this.remember(w);
        this.projects().forEach(p => {
          if (this.draining[p.folder]) return;
          this.draining[p.folder] = true;
          cx.spawn(async cx => {
            try {
              const delivery = await exec(`${home()}/.local/bin/herdr-team-runtime`, ['drain-project'], {cwd:p.folder,timeout:90000});
              if (delivery.code !== 0) throw new Error(delivery.stderr || '回報轉送失敗');
              this.queueStatus[p.folder] = JSON.parse(delivery.stdout);
            } catch(e) { if(this.workspace().folder === p.folder) this.error = `傳送服務：${e.message || e}`; }
            finally { this.draining[p.folder] = false; cx.notify(); }
          });
        });
        const dir = `${w.folder}/.herdr-team${w.chatId ? `/conversations/${w.chatId}` : ''}`;
        const [control, status, messages, result, review, model] = await Promise.all([
          readTextFile(`${dir}/control.json`), readTextFile(`${dir}/STATUS.md`), readTextFile(`${dir}/messages.jsonl`),
          readTextFile(`${w.folder}/RESULT.md`), readTextFile(`${w.folder}/REVIEW.md`), readTextFile(`${dir}/model.json`)
        ]);
        if(this.key(w) !== this.key(this.workspace())) return;
        const live = terminals().map(x => [terminalId(x), terminalState(x), x.report?.msg || x.status?.msg]);
        const next = JSON.stringify([control, status, messages, result, review, model, live]);
        if (this.error.startsWith('讀取紀錄失敗：')) this.error = '';
        if (next !== this.snapshot) {
          this.snapshot = next; this.control = control ? JSON.parse(control) : null;
          this.status = status || ''; this.result = result || review || ''; this.modelInfo = model ? JSON.parse(model) : null;
          this.events = (messages || '').split('\n').filter(Boolean).slice(-500).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
          const count = this.visibleMessages().length;
          if (count > this.lastMessageCount) this.scroll.scroll_to_item(count - 1);
          this.lastMessageCount = count;
          cx.notify();
        }
      } catch (e) { if (!this.error) { this.error = `讀取紀錄失敗：${e.message || e}`; cx.notify(); } }
      finally { this.refreshing = false; }
    });
  }
  choose(cx) {
    this.operation(cx, async () => {
      const folder = await pickFolder({ prompt: '選擇協作專案' });
      if (folder) {
        const p = this.projects().find(x => x.folder === folder), last = p?.chats?.slice(-1)[0];
        if (last) this.select({folder,...(last.id !== 'legacy' ? {chatId:last.id} : {})},cx);
        else this.newChat(cx,folder);
      }
    });
  }
  async log(role, text) {
    const w = this.workspace();
    const r = await exec(`${home()}/.local/bin/herdr-team-runtime`, ['log', role, text], { cwd: w.folder });
    if (r.code !== 0) throw new Error(r.stderr || '無法保存訊息');
  }
  send(cx) {
    const original = this.input.value(), text = original.trim(), w = this.workspace();
    if (!text) { this.error = '請先輸入訊息。'; cx.notify(); return; }
    if (!w.folder) { this.error = '請先新增或選擇專案。'; cx.notify(); return; }
    this.sending++; this.error = '';
    this.input.set_value(''); this.input.focus(); cx.notify();
    const previous=this.saveTail; let release; this.saveTail=new Promise(resolve=>{release=resolve;});
    cx.spawn(async cx => {
      try {
        await previous;
        const r = await exec(home()+'/.local/bin/herdr-team-runtime', this.args(w,['enqueue',text]), {cwd:w.folder,timeout:10000});
        if(r.code !== 0) throw new Error(r.stderr || '訊息未保存，請再試一次。');
        const answer = JSON.parse(r.stdout);
        const list=this.projects().slice(), p=list.find(x=>x.folder===w.folder), chat=p?.chats.find(x=>x.id===(w.chatId||'legacy'));
        if(chat?.title==='新對話') {chat.title=text.slice(0,24);setShared('team-chat.projects',list);}
        if(this.key(w)===this.key(this.workspace())) {
          this.events.push({role:'你',kind:'user',text,messageId:answer.id,delivery:'queued',time:new Date().toISOString()});
          this.info='已保存並排入對話。你可以繼續傳下一則，系統會依序處理。';
          this.input.focus(); this.snapshot=null;
          this.scroll.scroll_to_item(Math.max(0,this.visibleMessages().length-1));
        }
      } catch(e) {
        this.error=String(e.message||e);
        if(this.key(w)===this.key(this.workspace())) this.input.set_value(original+(this.input.value()?'\n'+this.input.value():''));
        else {const drafts={...(shared('team-chat.drafts')||{})};drafts[this.key(w)]=original+'\n'+(drafts[this.key(w)]||'');setShared('team-chat.drafts',drafts);}
      }
      finally {this.sending--;release();cx.notify();this.refresh(cx);}
    });
  }
  model(cx, value) {
    const w = this.workspace();
    if (!w.folder) { this.error = '請先選擇專案資料夾。'; cx.notify(); return; }
    this.operation(cx, async () => {
      const r = await exec(`${home()}/.local/bin/herdr-team-runtime`, this.args(w, ['switch-model', value]), {cwd:w.folder, timeout:15000});
      if (r.code !== 0) throw new Error(r.stderr || '模型尚未切換成功，請查看確認。');
      const result = JSON.parse(r.stdout);
      this.modelInfo = {model:result.model};
      this.info = result.message;
      this.snapshot = null;
    });
  }
  backup(cx) {
    const w = this.workspace();
    if (!w.folder) { this.error = '請先選擇專案資料夾。'; cx.notify(); return; }
    this.operation(cx, async () => {
      const r = await exec(`${home()}/.local/bin/herdr-team-runtime`, this.args(w, ['takeover', w.folder]), { cwd: w.folder });
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
  visibleMessages() {
    if (this.details) return this.events;
    const start = this.workspace().chatId ? 0 : Number(shared('team-chat.view-start')) || 0;
    return this.events.filter(m => m.kind !== 'delivery' && Date.parse(m.time || '') >= start && (m.kind === 'reply' || m.role === '你' || m.role === '系統' || !/已連線/.test(m.text || '')));
  }
  render() {
    const t = theme(), w = this.workspace();
    const id = this.control?.terminal || w.terminal;
    const lead = terminals().find(x => terminalId(x) === id);
    const state = terminalState(lead);
    const owners = [id, this.control?.previousTerminal].filter(Boolean);
    const workers = terminals().filter(x => owners.includes(x.parent));
    const blocked = [lead, ...workers].filter(Boolean).find(x => terminalState(x) === 'blocked');
    const working = [lead, ...workers].filter(x => x && terminalState(x) === 'working');
    const active = this.control?.role === 'codex' ? 'Codex 備援總控' : 'Claude 主總控';
    const project = (w.folder || '').split('/').filter(Boolean).pop();
    const currentChat = this.projects().find(p => p.folder===w.folder)?.chats.find(x=>x.id===(w.chatId||'legacy'));
    const queue = (this.queueStatus[w.folder] || []).find(x=>(x.chat||'legacy')===(w.chatId||'legacy'))?.chatQueue;
    const delivered = {};
    this.events.filter(x=>x.kind==='delivery').forEach(x=>{delivered[x.messageId]=x.delivery;});
    const messages = this.visibleMessages();
    const center = body => h_flex().w_full().min_w(0).justify_center().child(body.w_full().min_w(0).max_w(920));
    const button = (key, label, action, primary = false, disabled = this.busy) => Button.new(key)
      .accessibility_label(label).h(40).px(14).rounded(9).border_1()
      .border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.surface)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(13)
      .disabled(disabled).opacity(disabled ? 0.5 : 1).on_click((_e, cx) => action(cx)).child(label);

    const shell = v_flex().id('team-chat').track_focus(this.handle).h_full().w(0).flex_1().min_w(0).min_h(0)
      .bg(t.surface).text_color(t.foreground).text_size(13);
    const title = h_flex().items_center().gap(10);
    title.child(div().w(0).min_w(0).flex_1().truncate().text_size(20).font_semibold().child(currentChat?.title || '新對話'));
    title.child(button('chat-project', project || '選擇專案', cx => this.choose(cx)).tooltip(w.folder || '選擇要一起工作的資料夾'));
    title.child(button('chat-details', this.details ? '返回對話' : '協作紀錄', cx => {
      this.details = !this.details;
      cx.notify();
    }));
    const header = v_flex().px(24).py(18).gap(8).child(title);
    header.child(div().text_color(t.muted).child('Claude 總控  ·  Codex 實作  ·  MiniMax CN 測試與審查'));
    const modelRow = h_flex().items_center().gap(8);
    modelRow.child(div().text_color(t.muted).child('Claude 模型'));
    const chosen = this.modelInfo?.model || 'claude-opus-5-5';
    const modelBusy = this.busy || ['working','blocked'].includes(state);
    modelRow.child(button('chat-opus', 'Opus 5.5', cx => this.model(cx, 'claude-opus-5-5'), chosen === 'claude-opus-5-5', modelBusy));
    modelRow.child(button('chat-fable', 'Fable 5.2', cx => this.model(cx, 'claude-fable-5-2'), chosen === 'claude-fable-5-2', modelBusy));
    header.child(modelRow);
    const liveText = blocked ? `${agentName(blocked)}：需要你確認，工作暫停。` : working.length ? `目前調用：${[...new Set(working.map(agentName))].join('、')} · 處理中` : id ? `${active}：${statusName(state)}。` : '送出第一則訊息後啟動總控。';
    header.child(div().text_color(blocked ? t.blocked : t.muted).child(liveText));
    if(queue?.pending) header.child(div().text_color(t.muted).child(`等待處理：${queue.pending} 則${queue.reason==='another_conversation_busy' ? '；同專案的另一個對話正在處理，完成後接續。' : '；可繼續傳送訊息。'}`));
    if(queue?.reason==='another_conversation_busy') header.child(button('chat-jump-busy','查看處理中的對話',cx=>this.select({folder:w.folder,...(queue.blockingChat?{chatId:queue.blockingChat}:{})},cx)));
    shell.child(center(header));

    const feed = v_flex().id('chat-messages').flex_1().min_h(0).overflow_y_scrollbar()
      .track_scroll(this.scroll).px(24).py(12).gap(16);
    if (!messages.length) {
      const intro = v_flex().min_h(280).justify_center().gap(14);
      intro.child(div().text_size(30).font_semibold().child('想一起完成什麼？'));
      intro.child(div().text_size(16).text_color(t.muted).child('在下方說明需求，總控會安排實作與驗證，並在這裡回覆你。'));
      feed.child(center(intro));
    }
    messages.forEach((m, i) => {
      const row = h_flex().id(`chat-row-${i}`).w_full().min_w(0);
      if (m.role === '你') row.justify_end();
      const bubble = v_flex().min_w(0).max_w(m.role === '你' ? 720 : 860).p(18).gap(8).rounded(14)
        .bg(m.role === '你' ? t.raised : t.surface);
      const label = m.role === '你' && m.messageId ? `你 · ${(delivered[m.messageId] || m.delivery)==='sent' ? '已送出' : '等待處理'}` : m.role === '總控' ? active : m.role;
      bubble.child(div().text_size(12).font_semibold().text_color(t.muted).child(label));
      bubble.child(TextView.markdown(`chat-body-${i}`, m.text || '').w_full().text_size(15));
      row.child(bubble);
      feed.child(center(row));
    });
    if (this.details && this.status) {
      const progress = v_flex().p(18).rounded(12).bg(t.background);
      progress.child(div().font_semibold().child('進度紀錄'));
      progress.child(TextView.markdown('chat-status', this.status).w_full().text_size(13));
      feed.child(center(progress));
    }
    if (this.details && this.result) {
      const results = v_flex().p(18).rounded(12).bg(t.background);
      results.child(div().font_semibold().child('驗證與結果'));
      results.child(TextView.markdown('chat-result', this.result).w_full().text_size(13));
      feed.child(center(results));
    }
    shell.child(feed);

    const bottom = v_flex().px(24).pt(10).pb(18).gap(10);
    if (blocked) {
      const notice = h_flex().items_center().gap(12);
      notice.child(div().flex_1().text_color(t.blocked).child(`${agentName(blocked)} 正在等待確認，處理後才能繼續。`));
      notice.child(button('chat-confirm', '查看確認', () => run('terminal.peek', {terminal: terminalId(blocked)})));
      bottom.child(notice);
    }
    if (this.error) bottom.child(div().text_color(t.blocked).child(this.error));
    if (this.info) bottom.child(div().text_color(t.muted).child(this.info));
    const composer = v_flex().p(12).gap(10).rounded(14).bg(t.background).border_1()
      .border_color(this.inputFocused ? t.accent : t.input);
    composer.child(Textarea.new(this.input).accessibility_label('訊息').h(82).w_full().px(4).text_color(t.foreground).text_size(15));
    const sendRow = h_flex().items_center().gap(8);
    const hint = this.sending ? '正在保存訊息…' : blocked ? '等待確認；新訊息可先排隊' : 'Enter 送出 · Shift Enter 換行';
    sendRow.child(div().flex_1().text_size(12).text_color(t.muted).child(hint));
    sendRow.child(button('chat-send', '送出', cx => this.send(cx), true, false));
    composer.child(sendRow);
    bottom.child(composer);
    const actions = h_flex().items_center().gap(8);
    actions.child(button('chat-process', '查看詳細過程', () => this.open(), false, !id || this.busy));
    actions.child(button('chat-backup', 'Codex 接手', cx => this.backup(cx), false, !id || this.busy || this.control?.role === 'codex'));
    actions.child(div().flex_1().text_size(12).text_color(t.muted).child('@claude · @codex · @minimax；未指定時自動協作。'));
    bottom.child(actions);
    shell.child(center(bottom));
    const sidebar = v_flex().w(190).min_w(190).h_full().p(12).gap(8).bg(t.background).text_color(t.foreground);
    sidebar.child(div().font_semibold().text_size(16).py(8).child('專案與對話'));
    sidebar.child(button('sidebar-project-add','＋ 新增專案',cx=>this.choose(cx)).w_full());
    sidebar.child(button('sidebar-chat-add','＋ 新對話',cx=>this.newChat(cx),false,!w.folder||this.busy).w_full());
    const projectList = v_flex().id('sidebar-projects').flex_1().min_h(0).overflow_y_scrollbar().gap(8);
    this.projects().forEach((p,pi)=>{
      const group = v_flex().gap(4).py(6);
      const projectRow=h_flex().w_full().min_w(0).gap(4);
      projectRow.child(button(`project-${pi}`,p.name.slice(0,18),cx=>{
        const last=p.chats.slice(-1)[0]; this.select({folder:p.folder,...(last?.id && last.id!=='legacy'?{chatId:last.id}:{})},cx);
      }).w(0).flex_1().min_w(0).truncate().tooltip(p.folder));
      projectRow.child(button(`remove-project-${pi}`,'×',cx=>this.removeProject(p.folder,cx)).accessibility_label(`移除專案 ${p.name}`).tooltip('從側欄移除；保留檔案與對話紀錄'));
      group.child(projectRow);
      p.chats.forEach((chat,ci)=>{
        const selected = p.folder===w.folder && chat.id===(w.chatId||'legacy');
        group.child(button(`conversation-${pi}-${ci}`,chat.title.slice(0,10)+(chat.title.length>10?'…':''),cx=>this.select({folder:p.folder,...(chat.id!=='legacy'?{chatId:chat.id}:{})},cx),selected).w_full().truncate().tooltip(chat.title));
      });
      projectList.child(group);
    });
    sidebar.child(projectList);
    sidebar.child(div().text_size(12).text_color(t.muted).child('每個對話保留獨立紀錄與上下文。'));
    const frame=h_flex().size_full().min_h(0).bg(t.surface);
    frame.child(sidebar);frame.child(shell.flex_1().min_w(0));
    return frame;
  }
}
