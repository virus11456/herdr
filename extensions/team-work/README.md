# Herdr AI 協作聊天介面

這是 Herdr 桌面版的自訂 `team-work` 版面與 `team-chat` 面板，搭配 Claude 主總控、Codex 實作與備援、MiniMax CN 獨立驗證。保留專案／對話側欄、訊息佇列、協作紀錄、模型選擇、權限提示與 Codex 接手功能。

此目錄是介面擴充安裝包。需要已安裝提供 gpui-kit mod API 的 **Herdr 桌面版（herdr-app）與 herdr-core（hc）**；不能僅以此倉庫原有的舊版 `herdr` TUI 取代。來源快照日期：2026-11-19。

## 在另一台 Mac 安裝

1. 安裝上述 Herdr 桌面版與 core，以及 Node.js 20+、Claude Code（`claude`）、Codex CLI（`codex`）、MiniMax Code（`mcode`）。各代理的登入、信任與權限畫面由你自行完成；本安裝包不含帳號資料、不安裝這些程式、不代答確認。
2. 下載本 GitHub 倉庫，進入 `extensions/team-work`。若已安裝 Git，可執行：

   ```sh
   git clone https://github.com/virus11456/herdr.git
   cd herdr/extensions/team-work
   node install.mjs --dry-run
   node install.mjs
   ```

   若 Node 不在 PATH，可用你本機 Node 執行檔的完整路徑取代 `node`。安裝器會記住該路徑，不依賴來源電腦的使用者名稱或 Node 位置。
3. 將 `$HOME/.local/bin` 加入 PATH，開啟 Herdr 桌面版，執行：

   ```sh
   herdr-app check "$HOME/.config/herdr-app/mods/team-chat"
   hc templates
   herdr-app do layout.switch --name team-work
   ```

4. 在面板按「新增專案」選擇工作資料夾，再建立對話並輸入目標。送出訊息後才啟動總控；新機第一次的登入、信任或權限畫面請透過「查看確認」自行處理。

Linux 也可執行安裝器，但本快照未於 Linux 實機驗證。Windows 原生 shell 不支援此安裝包。

## 安裝內容與備份

安裝器會新增／更新下列自訂檔案，既有同名檔案先備份到 `~/.config/herdr-app/team-work-backups/<時間與識別碼>/`，附 `manifest.json`：

- `~/.config/herdr-app/mods/team-chat/{main.js,mod.json}`
- `~/.config/herdr-app/layouts/team-work.json`
- `~/.config/herdr-app/team-runtime.mjs` 與本機產生的 `team-claude-settings.json`
- `~/.local/bin/herdr-team-{lead,backup,claude,runtime}`
- `~/.config/herdr-core/templates/herdr-{claude-task,codex-implement,minimax-cn}.md`

若必要 CLI 在 PATH 的其他資料夾，安裝器會在 `~/.local/bin` 建立連結供 runtime 使用。它不變更 Herdr 出廠版面、全域代理設定、金鑰或登入憑證，也不自動切換目前版面。備份可能包含你既有的私人設定，請留在本機。

移除時先切回 Herdr 的 `main` 版面，依本機備份清單還原原檔，並只移除由本安裝包新增的檔案／工具連結。專案內的 `.herdr-team/` 是對話與交接資料，請自行決定是否保留。

## 協作與沙箱請求

未指定代理時，總控依任務安排協作。訊息開頭可用 `@claude`、`@codex`、`@minimax` 指定單一代理。只有實際回報及產物能證明任務完成；MiniMax 靜默不代表完成。模型按鈕沿用此快照的 Opus 5.5／Fable 5.2 識別字，不保證其他帳號或服務可用；請依你的服務提供者支援情況檢查 `team-runtime.mjs` 與面板中的模型對應。

Codex 沙箱不需直接連 hc socket；目前總控可在所選專案內執行：

```sh
herdr-team-runtime request list "{}"
herdr-team-runtime response <上一個命令回傳的id>
```

具名對話須在兩個命令加上 `--chat <對話id>`，位於 `request`／`response` 之前。面板必須保持開啟，才能在原生環境處理檔案佇列。`queued=true` 僅表示排入，仍須讀取回應的 `ok` 與結果。通道只接受目前總控，且限制到該團隊及專案範圍；不要重用其他電腦的終端 ID 或 control.json。

## 隱私與發佈範圍

本目錄只收錄明確選出的介面程式、範本、啟動器和安裝說明。未收錄 token、API key、`.env`、代理登入設定、Cookie、私人金鑰、專案清單、對話內容、`.herdr-team/`、測試產物或歷史備份。Claude hooks 設定由安裝器在新機本機產生。

面板透過 Herdr 原生 `exec`／`hc` 執行操作，會讀寫你選定專案的協作紀錄與 Herdr 自訂設定。代理程式啟動後會使用各自已設定的服務連線與登入；本面板未內建任何憑證。請勿在聊天、log 或 report 貼入憑證；此程式沒有對任意使用者輸入自動去識別或過濾密鑰。

可將此連結交給另一台電腦的代理：

> 請閱讀 virus11456/herdr 的 extensions/team-work/README.md，先檢查依賴並執行 dry run，再備份安裝 Herdr 協作介面。不要複製憑證或原電腦對話；登入與權限提示交給我，最後檢查面板及沙箱請求回應。

本次發布僅驗證安裝器、語法、面板載入及隔離目錄中的安裝行為；新機登入、實際派工與完整對話流程仍須在目的電腦驗證。
