# 驗證紀錄

日期：2026-11-19（Asia/Taipei）。這些是來源 Mac 的測試結果；另一台電腦仍須重新驗證。

## 面板與流程

| 驗證 | 結果 |
| --- | --- |
| Herdr 原生載入 | `herdr-app check` 通過，`status.errors` 為空 |
| 真實視窗 | 自訂 `team-work` 版面顯示輸入框、角色、紀錄、總控及備援按鈕 |
| 中文輸入與送出 | 從原生輸入框貼上完整繁體中文，按送出；紀錄保留原文，Claude 收到訊息 |
| Codex worker 回報 | 沙箱內寫入 outbox，面板轉送，Claude 終端實際收到對應 report ID |
| MiniMax worker 回報 | 獨立審查完成後寫入 outbox 並送達總控 |
| 狀態與來源 | 顯示 Herdr 的即時狀態與實際 STATUS／RESULT 檔案，不生成假的代理對話 |

一次早期自動化輸入使用鍵盤模擬造成中文字遺失；改為原生貼上後，已在輸入框、訊息檔及接收端核對完整原文。這筆早期測試不算通過證據。

## 真實跨代理任務

測試案例為零外部依賴的 Node.js 待辦清單 CLI：

1. Claude 總控 `t10` 透過 `hc run` 派工。
2. Codex 實作 `t11` 交付 `todo.mjs`、`test.mjs`、說明與實作紀錄。
3. MiniMax CN `t12` 獨立編寫並執行測試，交付 `REVIEW.md`。
4. Claude 檢查實際檔案、重跑驗證並寫入 `RESULT.md`。

實作方的測試包含 60 次 CLI 執行並通過。審查方報告 343 條通過斷言，也誠實記錄一個並行資料遺失問題，以及一條審查者自己預期寫錯的斷言。範例的單一寫入流程符合驗收；並行安全、不可見字元及部分文件問題保留為已知限制，不能把範例宣稱為生產級多寫入者工具。

MiniMax 有兩個額外命令被其權限分類器阻擋：工作區外的固定暫存檔，以及包含 `rm -rf` 的額外重現。兩者均未獲准，採取消／拒絕並收斂測試的方式完成報告，沒有停用分類器或使用 `--force`。

## 備援演練

以**明確標示的模擬 `StopFailure/rate_limit` 事件**呼叫同一個 hook 處理器，實際建立 Codex 備援 `t13`。沒有真的耗盡 Claude 額度、重設帳戶或更動付款。

Codex 讀取既有交接與產物，寫入 `BACKUP-CHECK.md`。直接 `hc` 因沙箱被拒絕後，透過 `request list` → 原生面板 → `response <id>` 的通道實際取得 `ok=true`：確認 `t10`、`t11`、`t12` 均已結束當前回合，自己為現任總控，未重複派工。

這證明實際接手與沙箱內請求往返可用；真實提供商額度錯誤的觸發種類依官方 hook 契約實作，未刻意在真實帳戶製造所有錯誤類型。`run`、越界與其他請求邊界由下列自動測試覆蓋，未另啟動第二輪 worker 來重複驗證。

## 自動測試

```sh
node --test team-runtime.test.mjs
perl -c configure-herdr.pl
perl -c install-panel.pl
```

`team-runtime.test.mjs`：**19 項通過，0 失敗**。包含額度事件、正常停止不誤切換、權限決策不繞過、停止失敗不另開總控、啟動失敗還原、單一總控登記鎖、路徑引號、沙箱回報、待確認訊息保留、現任總控驗證、worker 範本白名單、cwd 範圍、其他終端隔離，以及交棒後轉送既有 worker 回報。

## 版本檢查與範圍

Herdr 官方內建更新檢查成功，`checked` 有值、`checking=false`：App **0.1.16**、Core **0.1.21**，兩者 `ready=null`，沒有可用更新。

這個交付只新增獨立 Desktop 擴充包，沒有修改 Herdr TUI 的 Rust 核心，因此驗證使用 Node 測試與已安裝 App 的原生檢查；未執行整個上游 TUI 專案的 Rust build。未在全新第二台 Mac、Windows 或 Linux 驗證；目標 agent 應依部署文件完成本機驗收。

Herdr 必須開啟，面板需保持載入，才能建立備援分頁與處理檔案通道。強制終止期間的 exactly-once 投遞、全系統故障恢復、專案外 worktree allowlist 不在本版保證範圍。
