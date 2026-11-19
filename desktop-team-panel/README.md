# Herdr 多代理協作部署與交接

交給另一台電腦上的 agent 使用。這是安裝與設定流程，不是已部署到另一台電腦的證明。

## 交給目標 agent 的指令

> 請閱讀整份文件，先檢查這台電腦，再完成符合本機平台的部署。保留既有帳號、模型、設定與專案；只有需要時才安裝缺少的 CLI。先完成可獨立完成的工作，登入與工具自身的權限確認再交給使用者。不要要求使用者在聊天中貼 API Key、登入 token 或驗證碼。每一步以實際輸出驗證，不能只因下過命令就宣告成功。
>
> 角色固定：Claude 是主要總控，負責拆解、派工、整合與最終驗收；Codex 負責實作，也是備援總控；MiniMax CN 負責測試與審查。Claude 額度用盡或服務不可用時，保留工作並切到 Codex 總控。DeepSeek 不在這次部署範圍。
>
> 請完成 CLI、登入、Herdr 入口、共享交接紀錄、協作面板及一次真的跨代理實測。部署包包含面板、Claude 錯誤 hook、自動備援、檔案回報轉送與測試程式；仍須在目標電腦重新執行驗證，不能把來源機器的紀錄當作本機已通過。

## 1. 最終分工

| 工具 | 主要角色 | 帳號方式 |
| --- | --- | --- |
| Claude Code | 總控、拆解、派工、整合、驗收 | 使用者現有 Claude 訂閱登入 |
| Codex CLI | 實作；Claude 不可用時接任總控 | 使用者現有 ChatGPT 登入 |
| MiniMax Code CLI | 測試與審查 | **中國區 CN**，使用者的 Token Plan Plus 訂閱 |

MiniMax 訂閱 Key 與一般按量付費 API Key 不可互換。先採官方 Code CLI 的 CN 帳號登入方式；如果實際帳戶或方案不支援，再請使用者在官方工具本機的受保護欄位設定訂閱 Key，不能把一般 API Key 或國際區端點當成等價替代。

## 2. 檢查本機

以下流程以 macOS 為主。若目標是 Windows 或 Linux，停止套用 Mac 專用腳本，先依官方文件調整路徑及安裝方式。

```sh
uname -s
uname -m
sw_vers
command -v herdr-app
command -v hc
command -v claude
command -v codex
command -v mcode
command -v git
```

盤點版本、CLI 是否能從互動式 shell 啟動、Herdr 是否已開啟。不要讀出或列印認證檔的內容。`git --version` 必須真的能執行；僅有 `/usr/bin/git` 路徑，不代表 Xcode Command Line Tools 正常。

Herdr 桌面 App 的官方 Mac 下載目前提供 Apple Silicon。Intel Mac 請先核實桌面版支援，不要安裝錯誤架構；Herdr TUI 與 Herdr 桌面 App 是不同產品。

## 3. 安裝缺少的程式

先確認來源，下載腳本到工作資料夾檢查後執行。下面是官方文件提供的簡式指令；不要用 sudo 安裝使用者範圍的工具。

### Herdr 桌面 App 與核心

```sh
curl -fsSL https://releases.herdr.dev/app/install.sh | sh
```

開啟 Herdr 一次，使它產生符合版本的文件：

```text
~/.config/herdr-app/AGENTS.md
~/.config/herdr-app/herdr.d.ts
~/.config/herdr-app/gpui-kit.d.ts
```

### Claude Code

```sh
curl -fsSL https://claude.ai/install.sh | bash
```

### Codex CLI

已有可執行的 Codex CLI 就沿用。否則使用官方獨立安裝方式：

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

或已有 Homebrew 時：

```sh
brew install --cask codex
```

### MiniMax Code CLI

```sh
curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash
```

官方安裝器會在需要時準備自己的 Node.js runtime，通常不必先替整台機器安裝 Node。預設啟動器是 `~/.minimax-code/bin/mcode`。

**不要把這個 mcode shell 啟動器直接符號連結到別的目錄。** 本次實際測試發現它用自身位置尋找 `current`，直接連結會找錯路徑。附檔設定腳本用一層 `exec` wrapper 呼叫原始位置。

## 4. 登入與驗證

在使用者可見的終端或 Herdr 分頁完成登入。

```sh
claude auth login
claude auth status

codex login
codex login status

mcode login --region cn
```

MiniMax 必須指定 `cn`，不能指定 `global`。驗證登入完成訊息，再開啟 `mcode`，確認能進入 Ready 畫面；有需要可用 `/status` 檢查帳戶與區域。實際能否用到訂閱模型，仍須用一個小任務驗證。

登入、資料夾信任、工具執行權限是不同步驟。遇到 Claude 的資料夾信任確認，讓使用者確認實際專案；不要為了自動化而全域關閉安全限制。

## 5. 套用附檔設定

先讀 `configure-herdr.pl`，核對與本機既有設定不衝突後，在這個部署包目錄執行：

```sh
perl ./configure-herdr.pl
```

此腳本針對 macOS 預設安裝位置：Claude 為 `~/.local/bin/claude`，MiniMax 為 `~/.minimax-code/bin/mcode`。Codex 會從 PATH 與已知 App 路徑尋找，也可指定：

```sh
HERDR_CODEX_EXECUTABLE=/absolute/path/to/codex perl ./configure-herdr.pl
```

腳本會合併 `programs.json`、在有修改時備份原檔、加入缺少的 `~/.local/bin` PATH、建立下列入口與角色。請先檢查既有同名自訂檔案；若不是這個部署包建立的，不要直接覆寫。

```text
~/.local/bin/herdr-team-lead              Claude 主要總控
~/.local/bin/herdr-team-backup            Codex 備援總控
~/.config/herdr-app/programs.json         Herdr 選單入口
~/.config/herdr-core/templates/
  herdr-codex-implement.md                Codex 實作
  herdr-minimax-cn.md                     MiniMax CN 測試、審查
```

驗證：

```sh
zsh -lic 'command -v claude; command -v codex; command -v mcode; command -v hc'
hc templates
herdr-app status
```

Herdr 的 `+` 選單應能啟動 Claude Code、Codex、MiniMax CN、Claude - Team Lead、Codex - Backup Lead。不能只以選單出現判定完成；必須各開一次，確認實際啟動成功。

`啟動 Herdr 協作.command` 可雙擊選專案，也可從終端帶入專案路徑：

```sh
bash './啟動 Herdr 協作.command' '/absolute/path/to/project'
```

## 6. 總控與工作代理如何協作

先讀這台電腦上的 Herdr 文件與 `hc --skill`，以本機版本為準。不要把舊版 Herdr TUI 的命令混入桌面 App。

總控用互動式 CLI 派工，讓使用者可以看見、介入與延續；不要以多個分頁的存在當成代理已合作的證據。

```sh
hc run --bg --name implement --cwd '/absolute/path/to/project' \
  herdr-codex-implement '具體實作任務、可修改範圍、驗收條件、總控終端 ID；完成或受阻時用 hc send 回報，不得再派工。'

hc run --bg --name review --cwd '/absolute/path/to/project' \
  herdr-minimax-cn '唯讀檢查指定變更，執行必要驗證，回報可重現問題；附總控終端 ID，不得再派工。'
```

`hc run` 若回傳 `first_message.sent: false`，先讀畫面處理登入或信任狀態，不能盲目重送任務。

```sh
hc get implement
hc read implement --lines 60
hc send implement '補充或修正範圍'
hc wait implement
```

同一份工作樹一次只允許一位代理寫入。需要同時改碼時，先建立獨立 Git worktree。審查預設唯讀，避免邊審邊改破壞驗證對象。只清理這次部署或任務建立的終端，不要結束使用者原有工作。

## 7. 共享交接與 Codex 備援

每個專案保存：

```text
.herdr-team/STATUS.md       目標、驗收條件、進度、終端 ID、下一步、阻礙
.herdr-team/messages.jsonl 真實派工與回報紀錄
.herdr-team/control.json   目前總控與切換階段
.herdr-team/outbox/        沙箱內的待轉送回報
```

總控在派工前後與收到結果後更新紀錄。**備援總控先讀交接檔並檢查仍在跑的工作代理，不能重複派工。** 切換後只允許一位總控接收新任務；停止主總控的當前回合，再讓 Codex 接手。

`install-panel.pl` 會安裝 Claude 的單次啟動設定，在主總控啟動器中加入官方 `StopFailure` hook，不改動使用者的全域 Claude 設定。根據結構化的額度、服務、認證等錯誤，自動開啟 Codex 備援分頁；面板也有手動切換按鈕。

不把正常完成、使用者取消、輸出長度限制、未知錯誤或權限確認當成同一件事。Claude 必須從新的 `herdr-team-lead` 入口啟動才能載入 hook；之前已開啟的普通 Claude 分頁不會自動變成有 hook 的總控。

Herdr App 需要開啟才能建立備援分頁。App 不可連線時保留原總控紀錄並顯示失敗。面板需保持載入才能轉送檔案佇列；關閉 App 後不保證面板仍會運作。

Codex 沙箱可能阻止直接存取 `hc` 鎖與 Unix socket。工作代理優先執行以下指令，在專案內排入回報，再由面板轉送，**不解除沙箱**：

```sh
herdr-team-runtime report t10 Codex '真實工作摘要與產物路徑'
```

把 `t10` 換成這次任務的真實總控 ID。收件人若卡在權限決策，會保留訊息重試，不使用 `--force`。回報 ID 可辨識重複投遞；程序中斷時不宣稱嚴格 exactly-once。

Codex 備援總控也可能無法直接呼叫 `hc run/get`。它可透過受限的請求通道操作，繼續保留沙箱：

```sh
herdr-team-runtime request list '{}'
herdr-team-runtime response <上一個指令回傳的id>
```

可用動作為 templates、list、run、get、read、wait、send、interrupt。只有 `control.json` 指定的現任總控能提出請求；只允許既有團隊終端、已知的兩種 worker 範本及專案內 cwd。`queued` 只是已排入，必須檢查 response 的 `ok` 與實際結果。逾時先查同一個 id，不能盲目再啟動一個 worker。位於專案外的 worktree 不在預設授權範圍，需另行設計明確 allowlist，不要拿移除沙箱替代。

備援的實作與驗收規則：

1. 根據 Claude 的明確服務／額度錯誤或異常退出觸發，保留可重現的事件證據。
2. `blocked` 可能是權限或使用者問題，不能一律當成額度耗盡，也不能用備援繞過權限決策。
3. 使用者正常退出、取消任務、等待輸入時，不得自動啟動另一個總控。
4. 切換採一次性鎖或明確 active-lead 狀態，避免 Claude 與 Codex 同時派工及反覆切換。
5. 共享交接資料要足以恢復；不能假設另一個 CLI 自動繼承完整對話。
6. 用模擬故障驗證監督程式，再用真實小任務確認接手。模擬證據要標示模擬，不可假裝真的耗盡 Claude 額度。

## 8. 安裝 Herdr 小型協作面板

使用者希望在 Herdr 裡有一個小型對話框，能交代目標、看派工與回報，而不用手動在三個終端來回搬訊息。

先讀腳本與來源，再執行：

```sh
perl ./install-panel.pl '/absolute/path/to/project'
```

此腳本會安裝設定與面板，先跑 Herdr check，再複製原廠 `main` 為自訂的 `team-work` 版面，加入右側面板。被修改的檔案會備份；若已有同名個人版面或模組，先核對再執行。

- 任務輸入框，有可見標籤與送出中狀態。
- 顯示目前專案路徑、主總控 Claude、備援 Codex、Codex 實作、MiniMax CN 測試審查。
- 把使用者任務送給當前總控，顯示實際派工、代理回報、錯誤與等待使用者的狀態。
- 提供「開啟總控」與「切換至 Codex 備援總控」；切換不得產生兩位同時派工的總控。
- 顯示回報來源、時間及相關終端／產物；不能生成假的對話或用動畫冒充進度。
- 沒有任務或尚未連線時顯示明確空白狀態；發送失敗要顯示原因並保留輸入。

技術方式：

```text
~/.config/herdr-app/mods/team-chat/main.js
~/.config/herdr-app/mods/team-chat/mod.json
~/.config/herdr-app/layouts/<自訂名稱>.json
```

Herdr 使用原生 GPUI 模組，**不是 HTML/CSS 或瀏覽器網頁**。讀本機 `AGENTS.md`、`herdr.d.ts` 與 `gpui-kit.d.ts`；使用 `InputState` / `Input`、`exec`、`hc`、`run` 等本機版本提供的 API。參考原廠 `mods/prompt` 的輸入框寫法。

不得直接修改原廠 `main` layout 或 shipped mods：先 `layout.clone`，需要修改原廠 mod 才另外 `mod.clone`。不要改寫 App 每次啟動會重建的文件。`exec`、檔案寫入等副作用在 `checking()` 時必須略過。

```sh
herdr-app check ~/.config/herdr-app/mods/team-chat
herdr-app status
```

必須在真實視窗檢查輸入、送出、回報、切換與錯誤顯示，不能只靠 check 通過。目前每四秒讀取專案紀錄，只在檔案快照改變時通知重新繪製；終端狀態使用 Herdr 即時資料。

## 9. 一次真實協作實測

在新的隔離工作資料夾執行，不改使用者既有專案。建議小任務：用現有 Node.js runtime 實作一個無外部依賴的 JSON 待辦清單 CLI，支援新增、列出、完成，並為空輸入與未知 ID 提供清楚錯誤。

1. 使用者從面板或 Claude 總控輸入目標。
2. Claude 建立驗收條件及交接紀錄，真的用 `hc` 派工給 Codex。
3. Codex 真的產生可執行程式並回報；保留終端 ID 與檔案。
4. Claude 再交給 MiniMax CN 測試與唯讀審查。
5. MiniMax 真的執行測試並回傳可查證結果；有問題則交還 Codex 修正。
6. Claude 檢查實際產物並整合結果。
7. 使用者可在 Herdr 看見實際終端與回報；記錄測試命令、退出碼、產物路徑及未解問題。
8. 另測 Codex 接手後能讀取同一份交接資料並避免重複派工。

只登入成功、顯示 Ready、建立範本或跑一個模擬測試，都不能當成跨代理實測已通過。

## 10. 來源機器的實際狀態

記錄時間：2026-11-19，Asia/Taipei。這些是來源 Mac 的觀察，不能套用成目標電腦的驗證結果。

- Herdr App 0.1.16 已安裝，核心可操作。
- Claude Code 2.1.311 已安裝並以 Claude 訂閱登入；使用者已確認本次工作資料夾。
- Codex 0.166.0-alpha.5.1 已以 ChatGPT 登入，已在 Herdr 開啟操作介面。
- MiniMax Code 0.7.8 已用 `--region cn` 登入，已在 Herdr 顯示 Ready。
- Herdr 選單已能找到各 CLI；Claude 主總控、Codex 備援啟動器與角色範本已設定。
- 原生協作面板已通過 Herdr check 並在 App 中顯示，已實際送出訊息與接收 Codex 回報。
- 自動備援、檔案回報與受限總控請求通道已實作；完整測試結果與限制另見 `VALIDATION.md`。

## 官方來源

- [Herdr 桌面下載](https://herdr.dev/download/)
- [Herdr 桌面操作指南](https://herdr.dev/guide/)
- [Herdr Core 與派工](https://github.com/herdrdev/herdr-core)
- [Herdr Core 範本格式](https://github.com/herdrdev/herdr-core/blob/master/docs/templates.md)
- [Claude Code 官方快速入門](https://code.claude.com/docs/en/quickstart)
- [Claude Code 官方 StopFailure hook](https://code.claude.com/docs/en/hooks#stopfailure)
- [Codex CLI 官方安裝與登入](https://learn.chatgpt.com/docs/codex/cli)
- [MiniMax Code 官方安裝與 CN 登入](https://github.com/MiniMax-AI/minimax-code)
