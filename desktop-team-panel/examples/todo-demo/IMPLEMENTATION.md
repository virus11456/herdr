# 實作紀錄

## 交付範圍

新增 `todo.mjs`、`README.md`、`test.mjs` 與本文件。先讀取了 TASK.md；未修改 TASK.md、`.herdr-team/`、全域設定或登入資料，未安裝套件、部署、推送或啟動其他代理。所有測試資料均建立在本資料夾內的暫存子資料夾，測試完成後移除。

## 設計決策

- 僅使用 Node.js 內建模組，指定 runtime 實測為 v24.19.0。
- `add` 新增並輸出待辦物件；`list` 輸出包含已完成項目的陣列；`done` 依正整數 ID 標記完成。重複 `done` 成功且不重新寫檔。
- 預設使用執行時工作目錄的 `tasks.json`。`--file` 可位於命令前後，支援有空格及 Unicode 的路徑。`--` 結束選項解析，讓待辦文字可包含 `--file` 或以短橫線開頭。
- 文字保留原本的前後空白及 Unicode；只用 `trim()` 判斷是否全空白。多個文字參數以單一空格串接。
- 每次執行讀取磁碟資料。保存獨立的 `nextId` 計數器，完成項目不會降低計數器，也不會刪除待辦。若計數器比現有最大 ID 大很多，仍遵守保存的計數器。
- 寫入時先在目標旁以排他建立方式產生隨機暫存檔，完整寫入 UTF-8 JSON、同步並關閉，再透過 rename 置換目標。一般失敗會清理暫存檔；原檔在成功置換前保持原樣。

## 資料格式

```json
{
  "version": 1,
  "nextId": 2,
  "tasks": [
    { "id": 1, "text": "買牛奶 🥛", "done": false }
  ]
}
```

`version` 必須為 1。`nextId` 為正的安全整數；`tasks` 為陣列，每筆的 `id` 為唯一正安全整數且小於 `nextId`，`text` 為非空白字串，`done` 為 boolean。不符合格式的 JSON 也會拒絕。檔案不存在時視為 `{version:1,nextId:1,tasks:[]}`；唯讀 `list` 不會建立檔案。

## 錯誤處理

成功在 stdout 輸出單一 JSON 值與換行，退出碼 0。失敗在 stderr 輸出 `Error:` 及具體原因，stdout 為空，退出碼 1。

參數先驗證；空白文字、未知命令、不完整或重複 `--file`、未知選項、多餘參數及無效 ID 不會寫檔。未知 ID 在讀取後回報錯誤。JSON 語法錯誤、重複 ID、計數器錯誤、欄位型別錯誤及其他資料格式錯誤會停止處理，保留原檔位元組。讀取與寫入的檔案系統錯誤包含目標路徑與系統原因；不自動建立父目錄。

## 實際驗證命令與退出碼

以下命令均已在專案目錄實際執行：

| 命令 | 退出碼 | 結果 |
| --- | --- | --- |
| `~/.minimax-code/runtime/node/bin/node --version` | 0 | `v24.19.0` |
| `~/.minimax-code/runtime/node/bin/node --check todo.mjs` | 0 | 語法通過 |
| `~/.minimax-code/runtime/node/bin/node --check test.mjs` | 0 | 語法通過 |
| `~/.minimax-code/runtime/node/bin/node test.mjs` | 0 | `PASS: 5 test groups; 60 CLI executions (success: exit 0; expected errors: exit 1).` |

`test.mjs` 使用同一個 `process.execPath`，以獨立子程序執行 `todo.mjs`，每次都檢查退出碼、stdout 和 stderr；完整 argv 保存在測試程式內。60 次子程序執行中，13 次預期成功（實際退出碼均為 0），47 次預期失敗（實際退出碼均為 1）。

驗證涵蓋：

1. 預設路徑、空清單不建立檔案、Unicode 與前後空白保留、跨程序新增/讀取/完成、重複完成、完成後新增使用下一個 ID。
2. 自訂含空格與 Unicode 路徑、選項放在命令後、獨立清單、`--` 字面文字。
3. 空白文字、未知 ID、無效 ID、缺少或多餘參數、未知指令與選項、重複或不完整選項；每次確認原檔位元組不變。
4. 九種損壞或不符格式的資料分別執行 add/list/done，共 27 次拒絕；每次確認原檔文字不變。
5. 不存在清單的未知 ID、不存在父目錄的寫入、以資料夾當資料檔的讀取、ID 空間耗盡、遵循已保存的較大計數器，以及一般執行後無暫存寫入檔殘留。

## 已知限制與未測項目

- 未實作跨程序鎖定；兩個同時寫入的程序可能覆蓋彼此更新。ID 唯一性及不重用適用於依序執行且資料檔未被外部竄改的操作。
- ID 使用 JavaScript 安全整數；`nextId` 達 `Number.MAX_SAFE_INTEGER` 時拒絕新增，以免產生無法準確保存的下一個計數器。
- 沒有刪除、篩選或自動修復損壞資料的功能。任意 JSON 陣列不視為本工具的合法存檔。
- 原子置換使用同目錄 rename，替換後檔案使用新建檔案的權限（0600）；不保留原檔擁有者、其他權限或延伸屬性。目標若為符號連結，成功寫入會替換連結本身。
- 未進行並行競爭、磁碟寫滿、程序強制終止或斷電測試。檔案本身已同步，但沒有同步父目錄；不保證斷電時的目錄項目持久性。強制終止可能留下暫存檔。

## 交接阻礙

實作與本機驗證完成後，已實際執行 `hc send t10`，訊息包含完成摘要、60 次 CLI 驗證結果及本文件絕對路徑。命令退出碼為 **5**，回傳：

```json
{"error":{"hint":"check the core log in the state directory","kind":"unavailable","message":"cannot open core lock: Operation not permitted (os error 1)"}}
```

因此無法確認總控收到訊息。未更動核心狀態、登入資料、全域設定或安全限制，也未要求放寬權限。需由總控端處理 hc 核心鎖存取問題或直接讀取交付檔案；獨立審查仍應由審查者另外執行。
