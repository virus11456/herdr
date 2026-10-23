# herdr-web：herdr 的網頁控制台

用瀏覽器（包括手機）管理正在執行的 herdr：看所有 agent 的狀態、開 workspace / tab / pane、
送指令給 agent、讀 pane 輸出，以及編輯 `config.toml`。

它只透過 herdr 公開的 JSON socket API 溝通，不改動 herdr 本身。後端是一個 Python 3 檔案，
沒有任何第三方套件；前端是純 HTML/CSS/JS，不需要建置。

## 功能

- **儀表板**：即時列出 workspace → tab → pane，每個 pane 顯示 agent 狀態
  （工作中／等你回應／完成／閒置）。agent 進入「等你回應」或「完成」時跳出提示，
  分頁標題也會顯示等待數量。
- **操作 agent**：建立 workspace（可選擇建立後直接啟動 Claude Code、Codex 等 agent）、
  新增／重新命名／關閉 tab 和 pane、分割 pane、在 pane 裡啟動 agent。
- **Pane 畫面**：每 1.5 秒更新最近 400 行輸出；可以送文字、送 prompt 給 agent，
  也有 Enter、Esc、Ctrl+C、方向鍵、y/n、1/2/3 等快捷按鈕，方便在手機上回答 agent 的問題。
- **編輯設定**：直接編輯 `config.toml`。存檔前檢查 TOML 語法、自動備份上一版，
  存檔後自動 reload 並顯示 herdr 回報的錯誤；可以一鍵還原上一版，也可以查看預設設定當參考。
- **安全**：一定要密碼登入（有登入失敗次數限制），session cookie 是 `HttpOnly` 加
  `SameSite=Strict`，所有寫入請求都有 CSRF 防護，只開放安全的 API 方法
  （例如不能從網頁停止 herdr server）。

## 需求

- Linux 或 macOS（herdr 的 Unix socket）
- Python 3.9 以上；3.11 以上才能在存檔前檢查 TOML 語法
- 已安裝 herdr，並有 herdr server 在執行（網頁上也有「啟動 herdr server」按鈕）

## 聊天室（讓三個 AI 一起工作）

「聊天」分頁是預設首頁，用起來像群組聊天：

1. 按「＋ 新聊天室」，取名字、勾選要邀請的 AI（Claude、ChatGPT、Grok），再選一個專案資料夾。
2. 在下方輸入訊息，用「傳給：」的按鈕選擇要問誰。選多個時會**依序**回覆，
   後面的 AI 看得到前面的回覆，可以接著補充或修正。
3. 輸入框下方有一排常用按鈕：「💬 讓他們討論一輪」「🔍 互相檢查」「📝 總結」「📋 列待辦」
   「▶️ 繼續」「🧒 說簡單一點」「📂 看看資料夾」。按下後會替你送出對應的指令（會顯示成你的訊息，
   並用 @ 標明交給誰）。AI 回覆中這些按鈕會暫時變灰，避免重複按造成好幾輪一起跑；
   伺服器端也會拒絕在回覆中再開一輪討論。
4. **隊長模式**：建立聊天室時（或在「⋯」裡）選一個 AI 當隊長。你的訊息只交給隊長，
   隊長在回覆裡用「`@ChatGPT：要做的事`」這種格式分派任務，被指派的 AI 會自動收到並回報；
   全部回報後隊長會再檢查成果，決定繼續分派或向你總結。一則訊息最多分派 3 輪，避免用量失控。
5. **回覆和 @**：按 AI 泡泡旁的「↩ 回覆」可以針對那段話回應，訊息會直接交給那個 AI；
   在訊息裡打「@Claude」「@ChatGPT」「@Grok」「@Gemini」（打 @ 會跳出選單）就只交給被 @ 的 AI。
   這兩種都會跳過隊長。輸入框下方會顯示「→ 會傳給：…」。
6. AI 讀檔、改檔、執行指令時，泡泡上方會用中文顯示步驟；需要時可以按「■ 停止」。
7. 「⋯」裡可以切換「允許 AI 修改這個資料夾裡的檔案」（預設只能讀），或在 Finder 打開資料夾。

背後的做法：每個 AI 都用它官方命令列工具的非互動模式執行（`claude -p`、`codex exec`、`grok -p`），
讀取結構化輸出後畫成對話泡泡，並保留各自的對話 session。輪到某個 AI 時，會先轉述它上次發言後其他成員說了什麼。
沒登入時，泡泡裡會出現「登入」按鈕。聊天紀錄存在 `~/Library/Application Support/herdr-web/rooms/`（Linux 是 `~/.local/share/herdr-web/rooms/`），
刪除聊天室不會動到資料夾裡的檔案。每次回覆最多 30 分鐘，超過會自動停止。

## Mac App（DMG，不用開終端機）

打開 `HerdrWeb-<版本>.dmg`，把「Herdr Web」拖到「應用程式」，之後雙擊就會：

1. 沒裝 herdr 時詢問是否從 herdr.dev 安裝；
2. 需要 Python 3（macOS 會自動提示安裝「命令列開發者工具」）；
3. 在背景啟動 herdr 和控制台，用瀏覽器打開 `http://127.0.0.1:8787` 並自動登入。

App 沒有 Apple 開發者簽署，第一次打開會被擋下：macOS 15 以後到「系統設定 → 隱私權與安全性」按「強制打開」；
macOS 14 以前在 App 上按右鍵 →「打開」。只需要做一次。

登入密碼存在 `~/Library/Application Support/herdr-web/password`，記錄檔在 `~/Library/Logs/herdr-web.log`。

自己打包 DMG：

```bash
web-ui/macos/build-dmg.sh            # 在 Mac 上用 hdiutil，輸出到 web-ui/dist/
```

在 Linux 上打包需要 `hfsprogs` 的 `mkfs.hfsplus`，以及 libdmg-hfsplus 的 `hfsplus` 和 `dmg`
（用 `HFSPLUS_TOOL`、`DMG_TOOL` 環境變數指定）。

## 在自己電腦上使用（終端機）

```bash
git clone https://github.com/virus11456/herdr
cd herdr
./web-ui/start.sh
```

`start.sh` 會：

1. 找到 herdr（`PATH` 或 `~/.local/bin/herdr`）和 python3，缺了會告訴你怎麼裝；
2. herdr server 沒在跑就自動啟動（會還原上次的 workspace）；
3. 開一個只有本機連得到的網頁 `http://127.0.0.1:8787`，並自動打開瀏覽器、自動登入。

每次啟動都會產生新的隨機密碼，並透過網址的 `#` 片段交給瀏覽器自動登入。這段不會傳到伺服器，
登入後也會馬上從網址列清掉。之後要在別的分頁重新登入，就用終端機上印出的密碼。

按 `Ctrl+C` 只會關掉網頁控制台，herdr 和裡面的 agent 會繼續執行。下次再跑 `./web-ui/start.sh` 就能接回去。
你也可以同時在終端機執行 `herdr`，網頁和終端機看到的是同一個工作環境。

換 port：`./web-ui/start.sh --port 9000`。

## 準備 Claude、ChatGPT、Grok 的 agent

herdr 不直接連 AI 網站，而是在 pane 裡執行各家的命令列 agent。網頁的「啟動 agent」選單
預設把這三個排在最前面（可用 `--preferred-agents` 調整）：

| 你的訂閱 | 命令列工具 | herdr 名稱 | 一鍵安裝會執行 |
| --- | --- | --- | --- |
| Claude（Pro / Max） | Claude Code | `claude` | 官方安裝程式 `curl -fsSL https://claude.ai/install.sh \| bash` |
| ChatGPT（Plus / Pro） | Codex | `codex` | `install_codex.py`：從 npm registry 下載 OpenAI 官方的原生執行檔套件，驗證 SHA-512 後裝到 `~/.local/bin/codex`，不需要 Node.js |
| Grok | Grok Build | `grok` | 官方安裝程式 `curl -fsSL https://x.ai/cli/install.sh \| bash` |
| Gemini（Google 帳號） | Gemini CLI | `gemini` | `install_gemini.py`：沒有 Node.js 時從 nodejs.org 下載官方 LTS 版（驗證 SHA-256）放進私人資料夾，再用它安裝 `@google/gemini-cli`，並建立 `~/.local/bin/gemini` 啟動檔 |

首頁卡片顯示「還沒安裝」時點一下就能安裝。這些命令列工具和各家的桌面版 App 是不同的程式，
登入狀態和對話紀錄不共用，但用的是同一個帳號和訂閱；第一次使用時登入一次即可。

建議再安裝 herdr 的整合，讓狀態偵測和 session 還原更準確：

```bash
herdr integration install claude
herdr integration install codex
herdr integration install grok    # 需要已經有 ~/.grok 設定資料夾
```

## 手動啟動與參數

```bash
HERDR_WEB_PASSWORD='換成你的密碼' python3 web-ui/herdr_web.py --start-server
```

沒有設定 `HERDR_WEB_PASSWORD` 時，程式會隨機產生一組密碼並印在終端機上。

常用參數：

| 參數 | 說明 |
| --- | --- |
| `--host` / `--port` | 監聽位址，預設 `127.0.0.1:8787` |
| `--session NAME` | 管理 herdr 的具名 session |
| `--socket PATH` | 直接指定 herdr socket 路徑 |
| `--config PATH` | config.toml 路徑，預設 `~/.config/herdr/config.toml` |
| `--password-file PATH` | 從檔案讀密碼（取代環境變數） |
| `--tls-cert` / `--tls-key` | 直接提供 HTTPS |
| `--secure-cookie` | 前面有 HTTPS 反向代理時加上 |
| `--start-server` | herdr server 沒在跑就先啟動它 |
| `--open` | 啟動後打開瀏覽器；密碼是自動產生時會自動登入 |
| `--preferred-agents` | 選單最前面的 agent，預設 `claude,codex,grok,gemini` |
| `--data-dir` | 聊天室紀錄存放的位置 |

為了安全，herdr-web 預設只聽 `127.0.0.1`。如果要聽公開位址又沒有 TLS，程式會拒絕啟動，
因為密碼會以明文在網路上傳送。

## 之後想改放到 VPS，從手機連線

這個網頁等於可以在你的 VPS 上執行任意指令，**請不要把它用純 HTTP 直接開放到網際網路**。
下面三種方式擇一：

### 方式 A：Tailscale（最推薦，手機最方便）

1. VPS 和手機都安裝 Tailscale 並登入同一個帳號。
2. 在 VPS 上照「安裝步驟」把 herdr-web 跑在 `127.0.0.1:8787`。
3. 執行 `sudo tailscale serve --bg 8787`。
4. 手機打開 Tailscale 顯示的 `https://<機器名稱>.<tailnet>.ts.net`。

只有你 tailnet 裡的裝置連得到，而且自動有 HTTPS。
這時 herdr-web 要加上 `--secure-cookie`（改 `herdr-web.service` 的 `ExecStart`）。

### 方式 B：網域 + Caddy（自動 HTTPS）

1. 準備一個網域，把 DNS A 記錄指到 VPS。
2. 安裝 Caddy，參考 `deploy/Caddyfile.example` 設定反向代理到 `127.0.0.1:8787`。
3. herdr-web 加上 `--secure-cookie`。

這種方式公開在網路上，請一定使用夠長的隨機密碼。

### 方式 C：SSH tunnel（不用裝任何東西）

```bash
ssh -L 8787:127.0.0.1:8787 user@your-vps
# 然後在同一台電腦打開 http://127.0.0.1:8787
```

手機也可以用支援 port forwarding 的 SSH App（例如 Termius）。

## 安裝步驟（VPS，使用 systemd）

```bash
# 1. 安裝 herdr（裝到 ~/.local/bin）
curl -fsSL https://herdr.dev/install.sh | sh

# 2. 取得這個 repo（herdr-web 需要 web-ui/ 資料夾）
git clone https://github.com/virus11456/herdr ~/herdr

# 3. 設定密碼
printf 'HERDR_WEB_PASSWORD=%s\n' "$(openssl rand -base64 24)" > ~/.config/herdr-web.env
chmod 600 ~/.config/herdr-web.env
cat ~/.config/herdr-web.env          # 記下密碼

# 4. 安裝兩個 user service
mkdir -p ~/.config/systemd/user
cp ~/herdr/web-ui/deploy/herdr.service ~/herdr/web-ui/deploy/herdr-web.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now herdr herdr-web

# 5. 讓服務在登出後繼續執行
sudo loginctl enable-linger "$USER"
```

查看日誌：`journalctl --user -u herdr-web -f`。

想用 SSH 連進 VPS 時同時看到同一個工作環境，直接執行 `herdr` 就會連到同一個 server。
或者在自己電腦上用 `herdr --remote user@your-vps`。

## 測試

```bash
python3 -m unittest discover web-ui
```

測試會啟動一個假的 herdr socket，不需要真的 herdr server。

## 限制

- Pane 輸出是純文字（沒有 ANSI 顏色），每 1.5 秒輪詢一次，不是完整的終端機模擬器。
  需要完整互動（例如 vim）時，請用 SSH 執行 `herdr`。
- 主題、側邊欄、快捷鍵等設定只影響終端機裡的 herdr 畫面，不影響這個網頁。
- 瀏覽器通知需要 HTTPS（方式 A 或 B）。
- 不支援 Windows（herdr 在 Windows 上用 named pipe）。
