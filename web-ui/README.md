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

## 在自己電腦上使用（最簡單）

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

| 你的訂閱 | 要安裝的 CLI | herdr 名稱 | 安裝與登入 |
| --- | --- | --- | --- |
| Claude（Pro / Max） | Claude Code | `claude` | `npm install -g @anthropic-ai/claude-code`，執行 `claude` 後用 Claude 帳號登入 |
| ChatGPT（Plus / Pro） | Codex CLI | `codex` | `npm install -g @openai/codex`，執行 `codex` 後選「Sign in with ChatGPT」 |
| Grok | Grok CLI | `grok` | 依 xAI 官方說明安裝，執行 `grok` 登入一次 |

每個 CLI 先在一般終端機執行並登入一次，之後在 herdr 裡就能直接啟動。

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
| `--preferred-agents` | 選單最前面的 agent，預設 `claude,codex,grok` |

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
