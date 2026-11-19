# REVIEW — todo.mjs 待辦清單 CLI 獨立測試與審查

審查者：MiniMax CN（測試審查代理，終端 t12）
審查對象：`todo.mjs`、`README.md`
需求基準：`TASK.md`（僅讀取，未改寫）
審查日期：2026-11-19
Node runtime：`~/.minimax-code/runtime/node/bin/node` → `v24.19.0`（實際解析為 `$HOME/.minimax-code/runtime/node-v24.19.0-darwin-arm64/bin/node`）

---

## 0. 審查方法與邊界聲明

- 本審查**獨立**設計並執行測試，未以 `test.mjs` 或 `IMPLEMENTATION.md` 的敘述作為通過依據；實作者的 `test.mjs` 僅作為「第三方實作」另外重跑一次，確認其自述與退出碼。
- 所有測試資料只寫入本資料夾內的 `.review-tmp/`；`todo.mjs`、`README.md`、`test.mjs`、`IMPLEMENTATION.md`、`TASK.md`、`.herdr-team/` 皆未修改。依總控指示，`.review-tmp/` 測試資料**保留未刪除**，供總控覆核。
- 測試用 Node harness 共 3 支（`.review-tmp/harness.mjs`、`harness2.mjs`、`harness3.mjs`），以 `spawnSync`/`spawn` 啟動子程序，逐次比對**退出碼、stdout、stderr**，並以 SHA-256 對資料檔做**執行前後位元組比對**。
- 自動化斷言總計：**343 條通過**（harness1 301、harness2 15、harness3 27），**2 條失敗**，其中 1 條為實作真實缺陷（見 P1），1 條為我方斷言寫錯（見 P4，非產品問題）。
- 實際啟動 `todo.mjs` 子程序次數：**約 155 次**（harness1 102、harness2 20＋8 併行、harness3 15、手動逐項約 18），另加實作者 `test.mjs` 內部 60 次。

---

## 1. 實際執行的命令與退出碼

### 1.1 環境與語法檢查

| # | 命令 | 退出碼 | 輸出重點 |
|---|---|---|---|
| 1 | `~/.minimax-code/runtime/node/bin/node --version` | 0 | `v24.19.0` |
| 2 | `~/.minimax-code/runtime/node/bin/node --check todo.mjs` | 0 | 無輸出，語法通過 |
| 3 | `~/.minimax-code/runtime/node/bin/node --check test.mjs` | 0 | 無輸出，語法通過 |
| 4 | `~/.minimax-code/runtime/node/bin/node -e "console.log(process.execPath)"` | 0 | `$HOME/.minimax-code/runtime/node-v24.19.0-darwin-arm64/bin/node` |

### 1.2 核心功能手動逐項驗證（cwd = `.review-tmp/work1`、`.review-tmp/work2`，CLI = `../../todo.mjs`）

| # | 命令 | 退出碼 | 輸出重點 |
|---|---|---|---|
| 5 | `node ../../todo.mjs list`（空資料夾） | 0 | stdout `[]`；**`tasks.json` 未被建立**（目錄列示僅 `.`/`..`） |
| 6 | `node ../../todo.mjs add '買牛奶 🥛'` | 0 | `{"id":1,"text":"買牛奶 🥛","done":false}`；stderr 空 |
| 7 | `node ../../todo.mjs list` | 0 | `[{"id":1,"text":"買牛奶 🥛","done":false}]`（JSON 陣列） |
| 8 | `node ../../todo.mjs done 1` | 0 | `{"id":1,"text":"買牛奶 🥛","done":true}` |
| 9 | `node ../../todo.mjs list`（跨程序重讀） | 0 | `[{"id":1,…,"done":true}]` → **跨執行持久化成立** |
| 10 | `node ../../todo.mjs add 'second task'`（完成 id1 之後） | 0 | `{"id":2,…}` → **完成後 ID 不重用** |
| 11 | `node ../../todo.mjs done 1`（重複完成） | 0 | exit 0，stdout 與第一次相同（冪等） |
| 12 | `cat tasks.json` | 0 | `{"version":1,"nextId":3,"tasks":[{id:1,done:true},{id:2,done:false}]}` |
| 13 | `node ../../todo.mjs list`（在 work2） | 0 | `[]` → 預設檔取自**執行當下 cwd**，非腳本所在目錄 |
| 14 | `node ../../todo.mjs --file './我的待辦.json' add '閱讀 日本語 / English'` | 0 | `{"id":1,"text":"閱讀 日本語 / English","done":false}` |
| 15 | `node ../../todo.mjs --file './我的待辦.json' list` | 0 | 陣列含 Unicode 原文 |
| 16 | `node ../../todo.mjs --file './我的待辦.json' done 1` | 0 | `done:true` |
| 17 | `node ../../todo.mjs list --file './我的待辦.json'` | 0 | 讀到同一份 store → **`--file` 置於命令後有效** |
| 18 | `node ../../todo.mjs --file "$PWD/abs.json" add 'abs'` | 0 | 絕對路徑有效 |
| 19 | `node ../../todo.mjs --file "$PWD/abs.json" list` | 0 | 讀回 `abs` |
| 20 | `node ../../todo.mjs list`（work2） | 0 | `[]`，未受 `--file` store 影響 |
| 21 | `ls -1`（work2） | 0 | `abs.json`、`我的待辦.json`；**無預設 `tasks.json`** |
| 22 | `shasum -a 256 ../work1/tasks.json` | 0 | `d22ee8c9d34102cec75bc5c99695ace2119d24493348ca6597b12e1c76be7854`（work1 資料未被 work2 影響） |

### 1.3 自動化 harness 執行紀錄

| # | 命令 | 退出碼 | 結果 |
|---|---|---|---|
| 23 | `node .review-tmp/harness.mjs` | **0** | 301/301 斷言通過、0 失敗；內含 102 次 CLI 執行 |
| 24 | `node .review-tmp/harness2.mjs` | **1** | 15 通過 / 1 失敗；失敗項 = S10 併行寫入資料遺失（實作真實缺陷，見 P1）；另含 20 次 CLI 執行 + 8 個併行子程序 |
| 25 | `node .review-tmp/harness2.mjs`（第二次重跑） | **1** | S10 **再次重現**，且更嚴重（8 筆全回報 id 1，最終僅 1 筆落地） |
| 26 | `node .review-tmp/harness3.mjs` | **1** | 27 通過 / 1 失敗；失敗項 = 我方斷言對錯誤字串的期待寫錯（P4），非產品缺陷 |
| 27 | `node test.mjs`（實作者測試，於專案根目錄） | **0** | `PASS: 5 test groups; 60 CLI executions (success: exit 0; expected errors: exit 1).` |
| 28 | `node --check todo.mjs` / `node --check test.mjs`（專案根目錄） | 0 / 0 | 兩者皆語法通過 |

> 命令 27 執行前後已比對專案根目錄的 `.todo-test-*` 暫存資料夾：執行前 `[]`、執行後 `[]`，**無殘留**。

### 1.4 harness1（S1–S7）逐項涵蓋與實測結果

| 場景 | 涵蓋內容 | 結果 |
|---|---|---|
| S1 | 預設 `tasks.json`：`list` 空清單不建檔、`add`/`list`/`done` 皆輸出 JSON、重複 `done` 冪等、連續 3 筆 ID 為 1→2→3 不重用 | 9/9 通過 |
| S2 | `--file`：絕對路徑、含空格與 Unicode 的路徑、相對路徑、置於命令後、`--` 字面量（`--file literal text`、`-dash leading text`）、各 store 互不干擾 | 17/17 通過 |
| S3 | Unicode：ZWJ 家庭 emoji、代理對 U+1D11E、組合音符、阿拉伯／希伯來 RTL、全形 CJK、零寬連接字、含換行文字；逐筆 round-trip 比對 | 26/26 通過 |
| S4 | 22 種失敗輸入（空白文字 4 種、未知 ID、未知指令、無指令、未知選項、`done` 非法 ID 7 種、`list` 多餘參數、`--file` 4 種錯誤）；每項驗證 **exit≠0、stderr 有 `Error:`、stdout 為空、資料檔 SHA-256 完全不變** | 88/88 通過 |
| S5 | 16 種損壞／不符格式的 JSON 檔 × 3 種命令（`add`/`list`/`done`）＝48 次；每項驗證 exit≠0 與**原檔位元組完全保留** | 144/144 通過 |
| S6 | 不存在的檔案上的未知 ID（不建檔）、父目錄不存在（不自動建立）、以目錄當資料檔、寫入後無 `.tmp` 殘留 | 9/9 通過 |
| S7 | 已保存的較大 `nextId`（42）被遵守、`nextId = MAX_SAFE_INTEGER` 拒絕新增且檔案不變、`nextId` 低於既有 ID 時拒絕且檔案不變 | 8/8 通過 |

S5 涵蓋的 16 種損壞檔：`{broken JSON`、空檔、`null`、`[]`、`{}`、`id ≥ nextId`、重複 ID、空白 `text`、`done` 非 boolean、`version:2`、缺 `version`、`tasks` 非陣列、`nextId:0`、`nextId` 非整數、JSON 後有尾隨垃圾、BOM 前綴。

### 1.5 harness2（S8–S13）逐項涵蓋與實測結果

| 場景 | 涵蓋內容 | 結果 |
|---|---|---|
| S8 | README 逐句驗證：多個文字參數以單一空格串接、`list` 不建檔、首次 `add` 建檔、stdout 僅一個 JSON 值、儲存格式為 `{version,nextId,tasks}`、寫入檔權限為 `0600` | 6/6 通過 |
| S9 | 15 種空白字元對「空白文字」判定 | 見 P2 |
| S10 | 8 個併行 `add` 程序寫同一檔 | **失敗 → P1** |
| S11 | `--file` 指向 symlink | 見 P3(b) |
| S12 | 重跑實作者 `test.mjs` 並確認無殘留 | 2/2 通過 |
| S13 | README 所列的 `node --check` 驗證命令 | 2/2 通過 |

### 1.6 harness3（S14–S19）逐項涵蓋與實測結果

| 場景 | 涵蓋內容 | 結果 |
|---|---|---|
| S14 | 寫入失敗路徑：`--file` 為目錄（EISDIR）、唯讀父目錄（EACCES）、唯讀既有檔被 rename 取代（權限變 0600） | 行為正確（1 條為我方斷言錯誤，見 P4） |
| S15 | 文字保真：前後空白逐字保留、5000 字元長文字、JSON／HTML 元字元（`"`、`\`、`<tag>`、`&amp;`）逐字還原 | 6/6 通過 |
| S16 | 重複 `done` 不重寫檔案（SHA-256 與 mtime 皆不變）、stdout 與第一次完全相同 | 3/3 通過 |
| S17 | 資料檔內的額外欄位（`priority`）於 `done` 後仍保留；`list` 對不存在檔案不建檔 | 3/3 通過 |
| S18 | `--file` 指向「符號連結至目錄」→ EISDIR，exit 1 | 1/1 通過 |
| S19 | 副作用稽核：失敗執行（空白文字／未知 ID／未知指令／未知選項）皆**不會建立**資料檔 | 4/4 通過 |

---

## 2. 需求逐項判定

| 編號 | 需求（TASK.md 出處） | 判定 | 證據 |
|---|---|---|---|
| R1 | `--file <path> add <文字>` 增加待辦並輸出 JSON | **通過** | 命令 14、harness S2.1/S2.4、S8.1；exit 0，stdout 為單一 JSON 物件 |
| R2 | `--file <path> list` 輸出 JSON 陣列 | **通過** | 命令 15、17、S2.2/S2.5；stdout 為合法 JSON 陣列 |
| R3 | `--file <path> done <id>` 標記完成並輸出 JSON | **通過** | 命令 16、S2.3、S16.1；exit 0，stdout `done:true` |
| R4 | 無 `--file` 時使用**目前資料夾**的 `tasks.json` | **通過** | 命令 5–12（work1 建立 tasks.json）、13/20（work2 讀到空）、21（work2 無 tasks.json）；腳本位於專案根但資料檔建立於 cwd |
| R5 | 支援 Unicode 文字 | **通過** | S3 全部 26 條斷言（含 ZWJ、代理對、RTL、全形、換行）；S9 顯示 Unicode 空白判定正確 |
| R6 | 跨執行持久化 | **通過（依序執行）** | 命令 9、11、S1.5、S2.2、S3、S16；每次執行皆自磁碟重讀 |
| R7 | ID 唯一且不因完成待辦而重用 | **通過（依序執行）／併行下不成立** | 依序：命令 10（S1.6 → id 2）、S7.1（nextId 42 被保留）、S7.2（耗盡時拒絕且檔案不變）；**併行：P1** |
| R8 | 空白文字明確失敗、退出碼非零、不破壞原檔 | **通過**（P2 為邊界補充） | S4 前 4 項、S9 11 種空白字元、S19；exit 1、stderr `Error: Task text must not be blank.`、原檔 SHA-256 不變 |
| R9 | 未知 ID 明確失敗、退出碼非零、不破壞原檔 | **通過** | S4、S6.1；exit 1、stderr `Error: Unknown task ID: 999.`、原檔 SHA-256 不變 |
| R10 | 未知指令明確失敗、退出碼非零、不破壞原檔 | **通過** | S4、S19；exit 1、stderr `Error: Unknown command: unknown. Expected add, list, or done.`、原檔 SHA-256 不變 |
| R11 | 無效 JSON 檔案明確失敗、退出碼非零、不破壞原檔 | **通過** | S5 共 48 次；全部 exit 1、stderr `Error: Invalid JSON data in <path>: …`、原檔 SHA-256 不變 |
| R12 | 附 `README.md` 說明用法，且與實際行為一致 | **通過（3 處揭露不足，見 P3）** | S8、S9、S11、S13 逐句比對；命令 2/3/28、27 驗證 README 所列驗證步驟可執行 |
| R13 | 無外部依賴 | **通過** | `todo.mjs` 僅 `import` `node:fs/promises`、`node:crypto`、`node:path` |
| R14 | 使用指定 runtime、不依賴全域 `node` | **通過** | 命令 1、4；`process.execPath` 落在 `~/.minimax-code/runtime/...` |

**規格內需求 14 項：13 項完全通過，R7 在併行情境下有條件成立（見 P1）。R1–R14 沒有任何一項出現「失敗」。**

---

## 3. 可重現且有證據的問題

### P1（中）併行寫入靜默遺失資料，且不同程序回報相同 ID

**現象**：多個 `add` 程序同時寫同一個資料檔時，各程序皆以退出碼 0 與合法 JSON 回報成功，但多數待辦從未落地，且**不同待辦被回報相同 ID**。

**證據（`harness2.mjs` S10，連續兩次獨立執行）**：

第一次執行（命令 24）：
```
proc 1: exit=0 stdout={"id":1,"text":"concurrent 1","done":false}
proc 2: exit=0 stdout={"id":1,"text":"concurrent 2","done":false}
proc 3: exit=0 stdout={"id":1,"text":"concurrent 3","done":false}
proc 4: exit=0 stdout={"id":1,"text":"concurrent 4","done":false}
proc 5: exit=0 stdout={"id":2,"text":"concurrent 5","done":false}
proc 6: exit=0 stdout={"id":2,"text":"concurrent 6","done":false}
proc 7: exit=0 stdout={"id":2,"text":"concurrent 7","done":false}
proc 8: exit=0 stdout={"id":2,"text":"concurrent 8","done":false}
resulting file: {"version":1,"nextId":3,"tasks":[{"id":1,"text":"concurrent 4"},{"id":2,"text":"concurrent 8"}]}
tasks persisted: 2 / 8
```

第二次重跑（命令 25）：
```
proc 1..8: exit=0，全部 stdout id 為 1
resulting file: {"version":1,"nextId":2,"tasks":[{"id":1,"text":"concurrent 3"}]}
tasks persisted: 1 / 8
```

**成因**（原始碼定位）：`todo.mjs:98` 先 `loadStore()` 讀檔，`todo.mjs:107` 再 `saveStore()` 寫回，中間沒有任何鎖；`todo.mjs:87` 的 `rename()` 只保證「最終檔案不會寫壞」，**不保證 read-modify-write 的更新不會互相覆蓋**。因此先讀後寫的舊快照會覆蓋新快照。

**影響**：TASK.md 的「ID 唯一」在併行情境下不成立（`concurrent 1`…`concurrent 4` 全部拿到 id 1）；更嚴重的是被丟棄的 `add` 仍回 exit 0，呼叫端無從得知資料未落地，屬**靜默資料遺失**。

**是否為規格失敗**：TASK.md 的「跨執行持久化」語意為依序執行，故**不構成規格逐條失敗**；且 `README.md:29` 與 `IMPLEMENTATION.md:59` 已明載「此 CLI 不提供跨程序鎖定」。惟實際資料遺失幅度（8 筆僅存 1–2 筆）與「回報成功卻未落地」的靜默性，遠高於一般使用者的合理預期。

**重現方式**（`harness2.mjs` 保留於 `.review-tmp/`）：
```sh
cd "<專案資料夾>"
~/.minimax-code/runtime/node/bin/node .review-tmp/harness2.mjs
# 觀察輸出中 "===== S10" 段落
```
等价的独立重现脚本（与 `harness2.mjs` S10 相同的 `spawn` 實作）：
```js
import { spawn } from 'node:child_process';
const CLI = '<專案資料夾>/todo.mjs';
const procs = [];
for (let i = 1; i <= 8; i += 1) {
  procs.push(new Promise((res) => {
    const p = spawn(process.execPath, [CLI, '--file', './race.json', 'add', `concurrent ${i}`]);
    let o = ''; p.stdout.on('data', (d) => { o += d; });
    p.on('close', (code) => res({ i, code, out: o.trim() }));
  }));
}
console.log((await Promise.all(procs)).map((r) => `proc ${r.i}: exit=${r.code} ${r.out}`).join('\n'));
console.log('file:', require('fs').readFileSync('./race.json', 'utf8'));
```

> **聲明**：純 shell 的 `for … & … wait` 形式我曾嘗試執行，但被本次工作階段的權限規則阻擋，**該形式實際未執行成功**；上述證據全部來自已實際執行兩次的 Node `spawn` 版本（命令 24、25）。我不主張 shell 形式已重現。

### P2（低）無形 Unicode 格式字元被視為有效待辦文字

**現象**：`add` 的空白判定採用 JavaScript `trim()`（`todo.mjs:30`），而 ECMAScript 的 `trim()` 只移除 WhiteSpace／LineTerminator，不移除 format 類（Cf）無形字元。

**證據（harness2 S9，逐字元實測）**：

| 輸入字元 | 退出碼 | 結果 |
|---|---|---|
| U+0020 空格 / U+0009 Tab / U+000A LF / U+000D CR / U+000C FF / U+000B VT | 1 | `Error: Task text must not be blank.`（正確拒絕） |
| U+3000 表意空格 / U+00A0 NBSP / U+2000 / U+1680 / U+FEFF BOM | 1 | `Error: Task text must not be blank.`（正確拒絕） |
| **U+200B 零寬空格** | **0** | **接受**，`{"id":1,"text":"","done":false}` |
| **U+2060 WORD JOINER** | **0** | **接受**，`{"id":2,"text":"⁠","done":false}` |
| **U+200C 零寬不連字** | **0** | **接受**，`{"id":3,"text":"‌","done":false}` |
| **U+00AD 軟連字符** | **0** | **接受**，`{"id":4,"text":"­","done":false}` |

**影響**：可建立一筆在終端與常見編輯器中「完全看不見」的待辦，於是「空白文字必須明確失敗」對這些字元不成立。嚴重度低（一般使用者不會主動輸入），但屬可重現的邊界缺口。

**重現**：
```sh
~/.minimax-code/runtime/node/bin/node todo.mjs --file ./zwsp.json add $'\u200B'
# 退出碼 0，且建立 text 為 U+200B 的待辦
```

### P3（低）README 未揭露三項實際行為

**(a) 寫入會改變目標檔權限並取代原檔**
`todo.mjs:81` 以 `open(temporary, 'wx', 0o600)` 建立暫存檔，`todo.mjs:87` 以 `rename()` 置換目標，因此原檔的權限／擁有者／延伸屬性不會保留。
證據：S8.5 實測 `tasks.json` 權限為 `0600`；S14.3 實測原為 `0400` 的 `rofile.json` 在 `add` 後權限變為 `0600` 且內容被完整替換（`{"id":5,…,"nextId":6}`）。
`IMPLEMENTATION.md:62` 已載明，**`README.md` 未載**。

**(b) `--file` 指向 symlink 時，成功寫入會取代 symlink 本身，目標檔完全不變**
證據（S11.1）：`add` 經由 `link.json`（→ `real.json`）寫入後 exit 0，但 `link.json` 已不再是符號連結，而 `real.json` 內容仍是 `{"version":1,"nextId":1,"tasks":[]}`，**待辦寫到被替換掉的新檔案去了**。
`IMPLEMENTATION.md:62` 已載明，**`README.md` 未載**。

**(c) `done -1` 的錯誤訊息是選項錯誤而非 ID 錯誤**
`todo.mjs:20` 會先把所有以 `-` 開頭的參數視為選項，因此 `done -1` 回報 `Error: Unknown option: -1. Use -- before literal text starting with a dash.`（S4），而非 ID 專屬訊息。仍屬明確失敗、退出碼 1、原檔不變，**不影響需求判定**，僅訊息語意不精確。
同類未說明項：`done 01`（前導零）被拒絕；`--file` 的路徑不可為以 `--` 開頭的字串（`todo.mjs:15`）。

### P4（非產品缺陷，記錄以示透明）我方 harness 的斷言寫錯

harness3 的 S14.1 我原本斷言錯誤訊息應包含 `Cannot save`，實際為 `Error: Cannot read <path>: EISDIR: illegal operation on a directory, read` —— 因讀取階段即已失敗，早於寫入階段。**實作行為正確**（exit 1、錯誤明確、無 `.tmp` 殘留、目錄未被破壞），是我的斷言期待寫錯。此項不列入實作問題。

---

## 4. 未測到的項目（明確聲明）

以下項目本次**未**執行，不作任何通過宣稱：

1. **磁碟寫滿 / ENOSPC**、檔案系統配額耗盡時的寫入失敗行為。
2. **程序被 SIGKILL／強制終止／斷電**：暫存檔殘留清理、父目錄未 `fsync`（`todo.mjs:83-87` 只同步檔案本身）的崩潰一致性。
3. **真實多使用者與權限模型**：ACL、xattr、原檔擁有者與群組的保留。
4. **Windows／非 POSIX 平台**：`rename()` 置換語意與 `0600` 權限意義的差異。
5. **超大型資料檔**（數萬筆待辦）的效能、記憶體與 JSON 序列化成本。
6. **Node 版本相容性下限**：僅在 `v24.19.0` 實測；未驗證較舊版本的 `randomUUID`／`import.meta.url`／`??`／`?.` 相容性。
7. **以 shell `&`／`wait` 形式重現 P1**：該形式被本次階段權限規則阻擋，未執行；P1 證據僅來自 Node `spawn` 版本。
8. **symlink 指向不存在的目標、symlink 迴圈、自連結**等邊界。
9. **`--file` 路徑含 `~`**：`resolve()` 不展開 tilde（未加引號時由 shell 展開），未實測。
10. **Windows／macOS 以外平台的檔名限制**、以及非 ASCII 檔名的廣泛組合。
11. **`hc`／`herdr-team-runtime` 核心鎖權限**（本審查者沙箱內的連線能力），非 `todo.mjs` 範疇。
12. **實作者 `test.mjs` 內部 60 次子程序執行的逐次明細**：我僅重跑了整支測試並確認 exit 0 與無殘留，未逐條比對其斷言內容（其斷言正確性不影響本審查結論，本審查已以自有 343 條斷言獨立覆蓋）。

---

## 5. 總結論

1. **TASK.md 的每一項交付需求都已實測通過**（R1–R14，14 項中 13 項完全通過，R7「ID 唯一」在依序執行下完全成立、僅在併行下失效）。`add`／`list`／`done` 的 JSON 輸出格式、`--file` 的絕對／相對／含空格與 Unicode 路徑、無 `--file` 時採用執行當下 cwd 的 `tasks.json`、Unicode 逐字 round-trip、跨程序持久化、完成後 ID 不重用、以及四類失敗情境（空白文字／未知 ID／未知指令／無效 JSON）全部符合規格：**明確失敗、退出碼 1、stdout 為空、stderr 有具體原因、原檔 SHA-256 前後位元組完全相同**。
2. **實作品質良好**：採用同目錄暫存檔＋`fsync`＋`rename` 的原子置換；失敗路徑清理暫存檔且不污染原檔；參數驗證先於任何寫入；`done` 重複呼叫不重寫檔案；無外部依賴；使用 `process.exitCode`（而非 `process.exit()`）確保 stdout 完整 flush，實測未見輸出截斷。
3. **發現 3 個可重現的實質問題**，皆非規格逐條失敗：
   - **P1（中）** 併行 `add` 會靜默遺失資料並回報重複 ID（已重現兩次，8 筆僅落地 1–2 筆）；README／IMPLEMENTATION 已載明無跨程序鎖定，但未載明「會回報成功卻未落地」與「ID 會碰撞」的實際後果。
   - **P2（低）** U+200B／U+2060／U+200C／U+00AD 等無形 format 字元會被當成有效待辦文字。
   - **P3（低）** README 未揭露 symlink 會被取代、檔案權限會變成 0600、`done -1` 的錯誤訊息歸類為選項錯誤等三項實際行為。
4. **建議（供總控決定是否回派 Codex）**：
   - P1：在 README「已知限制」補一句明確後果（併行新增可能靜默遺失資料並回報相同 ID），或以 `mkdir`/`open` 鎖檔、`O_EXCL` 鎖檔或版本號比對（讀回 `nextId` 不符即重試）降低風險。
   - P2：空白判定在 `trim()` 之外，再排除 Cf 類無形字元（例如同時檢查 `/[\u200B-\u200F\u2060\uFEFF\u00AD]/`）。
   - P3：把 symlink 取代與 0600 權限行為補進 README。
5. **整體判定：可接受。** 規格逐條需求全部通過，未發現阻擋性缺陷；上述 3 項屬品質與文件層面的已知限制，無一項阻擋本次驗收。

---

## 6. 交接

- 本檔為本次審查唯一交付產物；`.review-tmp/` 內的 3 支 harness 與全部輸出紀錄（`harness-output.txt`、`harness2-output.txt`、`harness2-rerun.txt`、`harness3-output.txt`）依總控指示**保留未刪除**，供覆核。
- 本審查者未修改 `todo.mjs`、`README.md`、`test.mjs`、`IMPLEMENTATION.md`、`TASK.md`、`.herdr-team/`，未安裝套件、未部署、未啟動其他代理、未派工。
- 回報方式：依總控指示使用 `herdr-team-runtime report t10 MiniMax "<摘要及 REVIEW.md 路徑>"`。實際回報結果見本節末尾。

### 6.1 回報實測記錄

```sh
herdr-team-runtime report t10 MiniMax "<摘要及 REVIEW.md 路徑>"
```
- 退出碼：**0**
- 原始輸出：`{"queued":true,"id":"5192dfd4-bc9e-454e-8ad1-f61fe6adcfb2"}`
- 結論：回報已成功排入面板並將轉送總控終端 t10，**無權限／連線阻礙**。
