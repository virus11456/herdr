import { View, div, svg } from 'gpui-kit';
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, Button, TextView, ScrollHandle } from 'gpui-base';
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
    this.input.on('change', (_e, cx) => {
      if (checking()) return;
      const drafts = {...(shared('team-chat.drafts') || {})};
      drafts[this.key(this.workspace())] = this.input.value(); setShared('team-chat.drafts',drafts); cx.notify();
    });
    this.search = InputState.new({placeholder:'搜尋對話…'});
    this.search.on('change', (_e, cx) => cx.notify());
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
  setRoute(target, cx) {
    const text = this.input.value().replace(/^@(claude|codex|minimax)(?=\s|[：:，,]|$)[\s：:，,]*/i, '');
    this.input.set_value((target ? `@${target} ` : '') + text);
    this.input.focus();
    cx.notify();
  }
  fillPrompt(text, cx) {
    this.input.set_value(text);
    this.input.focus();
    cx.notify();
  }
  render() {
    const t = theme(), w = this.workspace(), width = this.width || 1000;
    const compact = width < 800;
    const showSidebar = this.sidebarExpanded ?? !compact;
    const sidebarWidth = width < 980 ? 216 : 248;
    const contentWidth = width - (showSidebar ? sidebarWidth : 0);
    const gutter = contentWidth < 560 ? 20 : 36;
    const id = this.control?.terminal || w.terminal;
    const lead = terminals().find(x => terminalId(x) === id);
    const state = terminalState(lead);
    const owners = [id, this.control?.previousTerminal].filter(Boolean);
    const workers = terminals().filter(x => owners.includes(x.parent));
    const blocked = [lead, ...workers].filter(Boolean).find(x => terminalState(x) === 'blocked');
    const working = [lead, ...workers].filter(x => x && terminalState(x) === 'working');
    const active = this.control?.role === 'codex' ? 'Codex' : 'Claude';
    const project = (w.folder || '').split('/').filter(Boolean).pop();
    const currentChat = this.projects().find(p => p.folder === w.folder)?.chats.find(x => x.id === (w.chatId || 'legacy'));
    const queue = (this.queueStatus[w.folder] || []).find(x => (x.chat || 'legacy') === (w.chatId || 'legacy'))?.chatQueue;
    const delivered = {};
    this.events.filter(x => x.kind === 'delivery').forEach(x => { delivered[x.messageId] = x.delivery; });
    const messages = this.visibleMessages();
    const chosen = this.modelInfo?.model || 'claude-opus-5-5';
    const modelBusy = this.busy || ['working', 'blocked'].includes(state);
    const route = this.input.value().match(/^@(claude|codex|minimax)(?=\s|[：:，,]|$)/i)?.[1]?.toLowerCase() || '';
    const icon = (name, size = 18) => svg(`mods/team-chat/icons/${name}.svg`).size(size).flex_shrink_0();
    const text = (value, size = 14, muted = false) => div().min_w(0).text_size(size).text_color(muted ? t.muted : t.foreground).child(value);
    const center = body => h_flex().w_full().min_w(0).justify_center().child(body.w_full().min_w(0).max_w(780));
    const button = (key, label, action, options = {}) => {
      const { glyph, primary = false, selected = false, disabled = false, quiet = false, small = false } = options;
      const body = h_flex().min_w(0).items_center().justify_center().gap(8);
      if (glyph) body.child(icon(glyph, small ? 16 : 18));
      if (label) body.child(div().min_w(0).truncate().child(label));
      return Button.new(key).accessibility_label(label || options.description || key)
        .h(small ? 32 : 40).px(label ? (small ? 10 : 12) : 10).rounded(small ? 8 : 10).border_0()
        .bg(primary ? t.solid : selected ? t.raised : quiet ? t.surface : t.background)
        .text_color(primary ? t.solid_foreground : t.foreground).text_size(small ? 12 : 13)
        .hover(el => el.bg(primary ? t.solid : t.raised))
        .disabled(disabled).opacity(disabled ? 0.4 : 1)
        .on_click((_e, cx) => action(cx)).child(body);
    };
    const pill = (label, color = t.muted) => h_flex().items_center().gap(6).child(div().size(6).rounded(3).bg(color)).child(text(label, 12, true));

    const shell = v_flex().id('team-chat').track_focus(this.handle).h_full().w(0).flex_1().min_w(0).min_h(0)
      .bg(t.surface).text_color(t.foreground).text_size(14);
    const header = h_flex().h(66).flex_shrink_0().px(20).items_center().gap(10).border_b_1().border_color(t.border);
    header.child(button('sidebar-toggle', '', cx => { this.sidebarExpanded = !showSidebar; cx.notify(); }, {glyph:'sidebar', quiet:true, description:showSidebar ? '收合側欄' : '展開側欄'}).tooltip(showSidebar ? '收合側欄' : '展開側欄'));
    const title = v_flex().w(0).flex_1().min_w(0).gap(4);
    title.child(div().truncate().font_semibold().text_size(15).child(currentChat?.title || '新對話').tooltip(currentChat?.title || '新對話'));
    title.child(text(project || '選擇專案，開始一段對話', 12, true).truncate());
    header.child(title);
    if (contentWidth > 630) {
      const models = h_flex().items_center().gap(3).p(3).rounded(10).bg(t.background);
      models.child(button('chat-opus', 'Opus 5.5', cx => this.model(cx, 'claude-opus-5-5'), {small:true, selected:chosen === 'claude-opus-5-5', disabled:modelBusy}));
      models.child(button('chat-fable', 'Fable 5.2', cx => this.model(cx, 'claude-fable-5-2'), {small:true, selected:chosen === 'claude-fable-5-2', disabled:modelBusy}));
      header.child(models);
    }
    header.child(button('chat-details', contentWidth > 540 ? '協作紀錄' : '', cx => { this.details = !this.details; cx.notify(); }, {glyph:'activity', quiet:true, selected:this.details, description:'檢視協作紀錄'}).tooltip(this.details ? '返回對話' : '檢視協作紀錄'));
    if (!showSidebar) header.child(button('header-new', '', cx => this.newChat(cx), {glyph:'edit', quiet:true, description:'新增對話', disabled:this.busy}).tooltip('新增對話'));
    shell.child(header);

    const statusBar = h_flex().px(gutter).py(10).items_center().gap(10).min_w(0);
    const liveText = blocked ? `${agentName(blocked)} 等待你確認` : working.length ? `${[...new Set(working.map(agentName))].join('、')} 處理中` : id ? `${active} · ${statusName(state)}` : '自動協作 · 依需求安排代理';
    statusBar.child(pill(liveText, blocked ? t.blocked : working.length ? t.working : t.muted));
    if (queue?.pending) statusBar.child(text(`${queue.pending} 則排隊中`, 12, true));
    if (queue?.reason === 'another_conversation_busy') statusBar.child(button('chat-jump-busy','查看處理中的對話',cx=>this.select({folder:w.folder,...(queue.blockingChat?{chatId:queue.blockingChat}:{})},cx),{small:true}));
    shell.child(center(statusBar));

    const feed = v_flex().id('chat-messages').flex_1().min_h(0).overflow_y_scrollbar()
      .track_scroll(this.scroll).px(gutter).py(20).gap(28);
    if (!messages.length) {
      feed.justify_center();
      const intro = v_flex().gap(16).py(24);
      intro.child(h_flex().items_center().gap(8).child(icon('spark',20)).child(text('你的 AI 工作空間',13,true)));
      intro.child(div().text_size(contentWidth < 500 ? 28 : 34).font_semibold().child('今天，想一起完成什麼？'));
      intro.child(text('從一個想法、一段程式，或一個還沒想清楚的問題開始。',15,true));
      const suggestions = [
        ['compass','釐清想法','整理目標，找出下一步','請幫我釐清這個想法，先一起確認目標、限制和下一步：'],
        ['code','打造功能','把需求轉成可用的成果','我想開發一個功能，請先檢查專案，再協助規劃實作與驗收：'],
        ['check','檢查程式','找出問題與改善機會','請獨立審查目前的程式，列出可重現的問題與驗證依據。'],
        ['book','整理資訊','把零散內容變得清楚','請協助整理以下內容，保留重點、待辦與需要確認的問題：']
      ];
      const cards = v_flex().gap(10).pt(12);
      for (let i = 0; i < suggestions.length; i += 2) {
        const row = contentWidth < 460 ? v_flex().gap(10) : h_flex().gap(10);
        suggestions.slice(i,i+2).forEach(([glyph,label,description,prompt],j) => {
          const body = v_flex().w_full().min_w(0).gap(8).items_start();
          body.child(h_flex().items_center().gap(9).child(icon(glyph,18)).child(text(label,14)));
          body.child(text(description,12,true));
          const card=Button.new(`prompt-${i+j}`).accessibility_label(`${label}：${description}`).w(0).flex_1().min_w(0).h(90).p(16).rounded(14).border_1().border_color(t.input).bg(t.surface).text_color(t.foreground).hover(el=>el.bg(t.background)).on_click((_e,cx)=>this.fillPrompt(prompt,cx)).child(body);
          if(contentWidth<460)card.w_full().flex_none();
          row.child(card);
        });
        cards.child(row);
      }
      intro.child(cards);
      feed.child(center(intro));
    }
    messages.forEach((m, i) => {
      const isUser = m.role === '你';
      const row = h_flex().id(`chat-row-${i}`).w_full().min_w(0).gap(12);
      if (isUser) row.justify_end();
      else row.child(div().size(30).flex_shrink_0().rounded(10).bg(t.background).border_1().border_color(t.border).flex().items_center().justify_center().child(icon(m.role === '系統' ? 'activity' : 'spark',16)));
      const bubble = v_flex().min_w(0).max_w(isUser ? 600 : 736).gap(9);
      if (isUser) bubble.px(18).py(14).rounded(20).bg(t.raised);
      const label = isUser ? (m.messageId && (delivered[m.messageId] || m.delivery) !== 'sent' ? '你 · 等待處理' : '你') : m.role === '總控' ? active : m.role;
      bubble.child(div().text_size(12).font_semibold().text_color(t.muted).child(label));
      bubble.child(TextView.markdown(`chat-body-${i}`,m.text || '').w_full().text_size(15));
      row.child(bubble);
      feed.child(center(row));
    });
    if (this.details) {
      const detail = v_flex().gap(16).p(20).rounded(16).bg(t.background).border_1().border_color(t.border);
      detail.child(h_flex().items_center().gap(8).child(icon('activity',18)).child(text('協作紀錄',15)));
      if (contentWidth <= 630) {
        const models = h_flex().gap(6);
        models.child(button('detail-opus','Opus 5.5',cx=>this.model(cx,'claude-opus-5-5'),{small:true,selected:chosen==='claude-opus-5-5',disabled:modelBusy}));
        models.child(button('detail-fable','Fable 5.2',cx=>this.model(cx,'claude-fable-5-2'),{small:true,selected:chosen==='claude-fable-5-2',disabled:modelBusy}));
        detail.child(text('Claude 模型',12,true)).child(models);
      }
      if (this.status) detail.child(TextView.markdown('chat-status',this.status).w_full().text_size(13));
      if (this.result) detail.child(text('驗證與結果',14)).child(TextView.markdown('chat-result',this.result).w_full().text_size(13));
      if (!this.status && !this.result) detail.child(text('任務開始後，這裡會保留分工、進度與驗證結果。',13,true));
      if (contentWidth <= 500) detail.child(button('detail-backup','Codex 接手',cx=>this.backup(cx),{small:true,disabled:!id || this.busy || this.control?.role==='codex'}));
      feed.child(center(detail));
    }
    shell.child(feed);

    const bottom = v_flex().px(gutter).pt(10).pb(16).gap(10).flex_shrink_0();
    if (blocked) bottom.child(h_flex().items_center().gap(8).child(icon('activity',18)).child(text(`${agentName(blocked)} 等待確認`,13)).child(button('chat-confirm','查看確認',()=>run('terminal.peek',{terminal:terminalId(blocked)}),{small:true})));
    if (this.error) bottom.child(div().text_size(13).text_color(t.blocked).child(this.error));
    if (this.info) bottom.child(text(this.info,12,true));
    const composer = v_flex().p(14).gap(10).rounded(20).bg(t.background).border_1().shadow_sm().border_color(this.inputFocused ? t.accent : t.input);
    composer.child(Textarea.new(this.input).accessibility_label('傳送訊息').h(60).w_full().px(2).text_color(t.foreground).text_size(15));
    const tools = h_flex().items_center().min_w(0).gap(4);
    tools.child(button('composer-project','',cx=>this.choose(cx),{glyph:'folder',description:'選擇工作專案',small:true}).tooltip(w.folder || '選擇工作專案'));
    const routes = contentWidth < 420 ? [['','自動'],['claude','C'],['codex','CX'],['minimax','M']] : contentWidth < 520 ? [['','自動'],['claude','Claude'],['codex','Codex'],['minimax','MiniMax']] : [['','自動協作'],['claude','Claude'],['codex','Codex'],['minimax','MiniMax']];
    routes.forEach(([target,label])=>{const name={claude:'Claude',codex:'Codex',minimax:'MiniMax'}[target];tools.child(button(`route-${target || 'team'}`,label,cx=>this.setRoute(target,cx),{small:true,selected:route===target}).accessibility_label(target ? `指定 ${name} 處理` : '自動協作').tooltip(target ? `指定 ${name} 處理` : '由總控安排協作'));});
    tools.child(div().flex_1());
    tools.child(button('chat-send','',cx=>this.send(cx),{glyph:'arrow-up',primary:true,description:'傳送訊息',disabled:!this.input.value().trim()}).w(38).h(38).rounded(19).tooltip('傳送訊息'));
    composer.child(tools);bottom.child(composer);
    const footer = h_flex().items_center().gap(8).min_w(0);
    footer.child(text(this.sending ? '正在保存訊息…' : 'Enter 傳送 · Shift Enter 換行',11,true).flex_1().min_w(0));
    footer.child(button('chat-process','詳細過程',()=>this.open(),{glyph:'terminal',small:true,quiet:true,disabled:!id || this.busy}));
    if (contentWidth > 500) footer.child(button('chat-backup','Codex 接手',cx=>this.backup(cx),{small:true,quiet:true,disabled:!id || this.busy || this.control?.role==='codex'}));
    bottom.child(footer);shell.child(center(bottom));

    const frame = h_flex().id('team-chat-frame').size_full().min_h(0).bg(t.surface).on_size_change((size,cx)=>{if(this.width!==size.width){this.width=size.width;cx.notify();}});
    if (showSidebar) {
      const sidebar = v_flex().w(sidebarWidth).min_w(sidebarWidth).h_full().p(12).gap(8).bg(t.background).text_color(t.foreground).border_r_1().border_color(t.border);
      const brand = h_flex().items_center().gap(10).px(8).py(12);
      brand.child(div().size(28).rounded(9).bg(t.solid).text_color(t.solid_foreground).flex().items_center().justify_center().child(icon('spark',17)));
      brand.child(div().text_size(18).font_semibold().child('Herdr'));
      brand.child(div().text_size(10).text_color(t.muted).px(6).py(3).rounded(5).border_1().border_color(t.input).child('TEAM'));
      sidebar.child(brand);
      sidebar.child(button('sidebar-chat-add','開啟新對話',cx=>this.newChat(cx),{glyph:'edit',selected:true,disabled:this.busy}).w_full().h(44));
      const search = h_flex().items_center().gap(8).px(10).h(38).rounded(9).bg(t.surface).border_1().border_color(t.border);
      search.child(icon('search',16)).child(Input.new(this.search).accessibility_label('搜尋專案與對話').w(0).flex_1().min_w(0).text_size(12).text_color(t.foreground));
      sidebar.child(search);
      const section = h_flex().items_center().px(8).pt(16).pb(4).gap(8);
      section.child(text('專案與對話',11,true).flex_1());
      section.child(button('sidebar-project-add','',cx=>this.choose(cx),{glyph:'plus',small:true,description:'新增專案'}).tooltip('新增專案'));
      sidebar.child(section);
      const query=this.search.value().trim().toLocaleLowerCase();
      const projectList=v_flex().id('sidebar-projects').flex_1().min_h(0).overflow_y_scrollbar().gap(12);
      let count=0;
      this.projects().forEach((p,pi)=>{
        const projectMatch=p.name.toLocaleLowerCase().includes(query);
        const chats=p.chats.filter(chat=>!query || projectMatch || chat.title.toLocaleLowerCase().includes(query));
        if(query && !projectMatch && !chats.length)return;
        count++;
        const group=v_flex().gap(3);
        const projectRow=h_flex().items_center().w_full().min_w(0).gap(2);
        const folderLabel=h_flex().w_full().min_w(0).items_center().gap(8).child(icon('folder',16)).child(div().w(0).flex_1().min_w(0).truncate().text_size(12).font_semibold().child(p.name));
        projectRow.child(Button.new(`project-${pi}`).accessibility_label(`開啟專案 ${p.name}`).w(0).flex_1().min_w(0).h(36).px(8).rounded(8).border_0().bg(t.background).text_color(t.foreground).hover(el=>el.bg(t.raised)).tooltip(p.folder).on_click((_e,cx)=>{const last=p.chats.slice(-1)[0];this.select({folder:p.folder,...(last?.id&&last.id!=='legacy'?{chatId:last.id}:{})},cx);}).child(folderLabel));
        projectRow.child(button(`remove-project-${pi}`,'',cx=>this.removeProject(p.folder,cx),{glyph:'close',small:true,description:`移除專案 ${p.name}`}).w(28).h(28).tooltip('從側欄移除；保留檔案與對話'));
        group.child(projectRow);
        chats.forEach((chat,ci)=>{
          const selected=p.folder===w.folder&&chat.id===(w.chatId||'legacy');
          const label=h_flex().items_center().gap(8).w_full().min_w(0).child(icon('chat',14)).child(div().w(0).flex_1().min_w(0).truncate().text_size(12).child(chat.title));
          group.child(Button.new(`conversation-${pi}-${ci}`).accessibility_label(`${selected?'目前對話：':''}${chat.title}`).w_full().min_w(0).h(38).px(10).rounded(9).border_0().bg(selected?t.raised:t.background).text_color(selected?t.foreground:t.muted).hover(el=>el.bg(t.raised)).tooltip(chat.title).on_click((_e,cx)=>this.select({folder:p.folder,...(chat.id!=='legacy'?{chatId:chat.id}:{})},cx)).child(label));
        });
        projectList.child(group);
      });
      if(!count)projectList.child(v_flex().px(8).py(12).gap(8).child(text(query?'沒有符合的對話':'還沒有專案',13)).child(text(query?'試試其他關鍵字。':'新增工作資料夾，讓對話與成果保留在一起。',12,true)));
      sidebar.child(projectList);
      const team=v_flex().p(12).gap(10).rounded(12).bg(t.surface).border_1().border_color(t.border);
      team.child(text('協作團隊',11,true));
      [['C','Claude','總控'],['>','Codex','實作與備援'],['M','MiniMax','測試與審查']].forEach(([mark,name,role])=>{
        const row=h_flex().items_center().gap(8);
        row.child(div().size(24).rounded(8).bg(t.raised).flex().items_center().justify_center().text_size(11).font_semibold().child(mark));
        row.child(text(name,12).flex_1()).child(text(role,10,true));
        team.child(row);
      });
      sidebar.child(team);
      sidebar.child(text('每個對話，都有自己的工作脈絡。',10,true).px(4).py(4));
      frame.child(sidebar);
    }
    frame.child(shell);
    return frame;
  }
}
