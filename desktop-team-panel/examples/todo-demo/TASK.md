# 真實 Herdr 協作測試

使用者已授權在這個獨立資料夾進行協作測試。禁止修改此資料夾以外的專案、全域設定或登入資料；不安裝套件、不部署、不購買服務。不要改寫本文件。

## 交付

實作無外部依賴的 Node.js 待辦清單 CLI `todo.mjs`，支援：

- `node todo.mjs --file <json路徑> add <文字>`：增加待辦並輸出 JSON。
- `node todo.mjs --file <json路徑> list`：輸出 JSON 陣列。
- `node todo.mjs --file <json路徑> done <id>`：標記完成並輸出 JSON。
- 沒有 `--file` 時使用目前資料夾的 `tasks.json`。
- 支援 Unicode 文字與跨執行持久化；ID 唯一且不因完成待辦而重用。
- 空白文字、未知 ID、未知指令、無效 JSON 檔案必須明確失敗，退出碼非零，且不破壞原檔。
- 附 `README.md` 說明用法；實作代理可以自帶測試，但審查者必須獨立驗證。

Node runtime 使用 `~/.minimax-code/runtime/node/bin/node`（本機已有），不依賴尚未設定的全域 `node` 或 Xcode 工具鏈。

## 協作與證據

Claude 是主總控，Codex 寫程式，MiniMax CN 是測試與審查者。Claude 不得代寫實作以冒充派工。

總控請先執行 `hc --skill` 和 `hc templates`。使用目前已安裝的 `herdr-codex-implement`、`herdr-minimax-cn` 範本，互動式啟動，每個工作代理不得再派工。

在本資料夾的 `.herdr-team/STATUS.md` 保存目標、分工、實際 terminal ID、進度與阻礙。工作代理完成或受阻，必須用 `hc send <總控終端ID>` 回報。總控等待應使用 `hc wait`，不要自行猜測靜默等於完成。

實作寫 `IMPLEMENTATION.md`，審查寫 `REVIEW.md`（附實際命令與退出碼，指出未測到的項目）。總控檢查真實產物後寫 `RESULT.md`，包含兩位工作代理的終端 ID、測試結果、實際問題與修復、未完成事項。

若遇到登入、權限、額度或服務錯誤，立刻回報具體原因與交接狀態，不得自行降低安全限制，也不能宣告成功。
