herdr 控制台（Herdr Web）

安裝
1. 把「Herdr Web」拖到旁邊的「Applications（應用程式）」資料夾。
2. 到「應用程式」資料夾雙擊「Herdr Web」。

第一次打開時，macOS 可能會說「無法驗證開發者」，因為這個 App 沒有向 Apple 付費簽署。這時：
- macOS 15 以後：打開「系統設定」→「隱私權與安全性」，往下找到 Herdr Web，按「強制打開」。
- macOS 14 以前：在「應用程式」資料夾對 Herdr Web 按右鍵 →「打開」→ 再按「打開」。
只需要做一次。

它會做什麼
- 沒裝 herdr 時會問你要不要從 herdr.dev 安裝。
- 需要 Python 3；如果 macOS 跳出「安裝命令列開發者工具」，請按安裝，完成後再打開一次 App。
- 在背景啟動 herdr 和網頁控制台，然後用瀏覽器打開 http://127.0.0.1:8787 並自動登入。
- 網頁只有這台 Mac 連得到。

之後每次想打開控制台，雙擊 Herdr Web 就好。關掉瀏覽器分頁不會停止 herdr 和 agent。

記錄檔：~/Library/Logs/herdr-web.log
登入密碼：~/Library/Application Support/herdr-web/password
