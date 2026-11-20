# RESULT — Herdr 真實協作測試（todo.mjs）

**結論：TASK.md 的交付需求全部通過實作者自測、MiniMax CN 獨立審查與總控覆核；無阻擋性缺陷。審查找到 3 個規格外的品質／文件問題，本輪未回派修復（列於未完成事項）。協作流程本身有 3 個實際阻礙，均如實記錄。**

## 終端
| 角色 | 範本 | 名稱 | 終端 ID | 結果 |
|---|---|---|---|---|
| 主總控 Claude | — | — | t10 | 派工、等待、檢查、整合 |
| 實作 Codex | herdr-codex-implement | todo-impl | **t11** | 完成（3 分 16 秒） |
| 測試審查 MiniMax CN | herdr-minimax-cn | todo-review | **t12** | 完成（兩度卡在核准畫面，由使用者處理） |

兩者皆以 `hc run --bg --name … --cwd … <範本> <任務>` 互動式啟動，`first_message.sent=true`，皆指示不得再派工。非 Git 專案，採一次一個寫入者：Codex 完成後才啟動審查；審查未改動實作檔。

## 產物（皆實際存在）
- Codex：`todo.mjs`、`README.md`、`test.mjs`、`IMPLEMENTATION.md`
- MiniMax：`REVIEW.md`（273 行）；`.review-tmp/`（3 支 harness 與輸出，依使用者在 t12 的指示保留未刪）
- 總控：`.herdr-team/STATUS.md`、本檔

## 測試結果
| 來源 | 內容 | 結果 |
|---|---|---|
| Codex 自測 | `node --check` 兩檔；`node test.mjs`（60 次 CLI 執行） | 全部 exit 0，PASS |
| MiniMax 獨立審查 | 3 支自製 harness：343 條斷言通過、約 155 次 CLI 執行；另重跑 test.mjs | R1–R14 全數通過；2 條斷言失敗＝P1 真實缺陷 1 條＋審查者自己寫錯的斷言 1 條 |
| 總控覆核 | 審查前後各重跑 `test.mjs`；scratchpad 抽驗核心流程與失敗情境；重現 P1、P2；核對 harness 輸出摘要與 REVIEW.md 一致 | test.mjs 兩次 PASS exit 0；抽驗全符合；P1、P2 皆重現 |

需求逐項（依 REVIEW.md，總控抽驗一致）：add／list／done 輸出 JSON、`--file`、無 `--file` 用 cwd 的 `tasks.json`、Unicode、跨執行持久化、ID 完成後不重用、空白文字／未知 ID／未知指令／無效 JSON 皆 `Error: …`＋exit 1＋原檔 SHA-256 不變、README、零依賴、指定 Node runtime（v24.19.0）——皆通過。「ID 唯一」僅在依序執行下成立（見 P1）。

## 審查發現的實際問題（皆非 TASK.md 逐條失敗；本輪未修復）
- **P1（中）併行 add 靜默遺失資料且回報重複 ID**：無跨程序鎖，read-modify-write 互相覆蓋。審查者重現兩次（8 筆落地 2 筆、1 筆）；總控以 shell 併行 8 個 add 重現：8 個程序皆 exit 0 且都回報 id 1，最後檔案只剩 1 筆。README／IMPLEMENTATION 有寫「不提供跨程序鎖定」，但沒寫後果是「回報成功卻沒存到」。
- **P2（低）不可見字元被當成有效文字**：`add $'​'` exit 0 並建立一筆看不見的待辦（總控重現）；U+2060、U+200C、U+00AD 同（審查者證據）。一般空白（含全形空格、NBSP、BOM）正確拒絕。
- **P3（低）README 未揭露**：寫入後檔案權限變 0600 且取代原檔；`--file` 指向 symlink 時會取代連結本身、目標檔不變；`done -1` 的錯誤訊息是「未知選項」而非 ID 錯誤。

## 協作流程的實際阻礙與處理
1. **Codex 無法 `hc send`**：退出碼 5，`cannot open core lock: Operation not permitted (os error 1)`（Codex 沙箱擋住 hc 核心鎖）。Codex 未放寬限制並寫入 IMPLEMENTATION.md。總控改以 `hc wait` 狀態＋`hc read t11`＋實際檔案確認完成；之後 t11 的回報經專案內檔案佇列（`herdr-team-runtime report`，非總控建立）轉送到達。hc send 本身未修復。
2. **MiniMax 兩度 blocked（permission）**：(a) 測試命令用 `2>/tmp/err.txt` 寫到資料夾外——違反派工範圍；(b) 重現併行的命令含 `rm -rf race`（在 `.review-tmp/` 內）。兩次都被 MCode 分類器攔下。總控未核准、未 `--force`；嘗試代選「Deny」被總控端權限檢查拒絕，改交使用者處理。使用者在 t12 指示停止新命令、直接寫 REVIEW.md，因此 shell 形式的併行重現審查者未執行（REVIEW.md 已聲明），`.review-tmp/` 也未清理。MiniMax 最後也是用 `herdr-team-runtime report` 回報（exit 0），不是 `hc send`。
3. **使用者中途訊息亂碼**：17:13 的訊息到總控時中文字大多遺失（`.herdr-team/messages.jsonl` 內同樣殘缺），其中 `herdr-team-runtime log Claude "…"` 的內容無法辨識，未執行。

## 未完成事項
- [ ] P1／P2／P3 未回派 Codex 修復、未再審（需使用者決定是否進行第二輪）
- [ ] Codex 沙箱下 `hc send` 不可用（屬範本／全域設定，本測試不動）
- [ ] `.review-tmp/` 保留未刪；t11、t12 終端尚未 kill/rm
- [ ] 審查未涵蓋項目見 REVIEW.md 第 4 節（磁碟寫滿、強制終止、其他平台、超大檔等）
