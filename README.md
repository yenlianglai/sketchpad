# sketchpad

用 iPad 同時 **手繪 + 語音** 跟正在跑的 Claude Code session 互動的 POC。

走的是 Claude Code **Channels**（research preview）：這個 repo 的 server 是一個 MCP server，
由 Claude Code 以 stdio 拉起，同一個 process 也對 iPad 提供網頁畫布 + 麥克風 UI。

```
iPad Safari (canvas + SpeechRecognition)
   │  POST /turn  { transcript, canvas.png }          ┌────────────────────────┐
   ▼                                                  │  Claude Code session    │
server/channel.mjs ── notifications/claude/channel ──▶│  <channel source=sketch │
   ▲                                                  │   file_path=inbox/x.png>│
   │  WebSocket  { reply text, files }  ◀── reply tool ─┤                        │
iPad Safari                                           └────────────────────────┘
```

一個「回合」= 使用者說完一段話（1.8 秒靜音）或按「送出」時，把 **逐字稿 + 當下畫布 PNG** 打包送進 session。
Claude 用 Read 看圖，用 `reply` tool 把文字或圖檔推回 iPad，iPad 可朗讀回覆。

## 前置條件

| 項目 | 說明 |
| --- | --- |
| Node ≥ 22.12 | server 與測試用。`node --version` |
| Claude Code ≥ 2.1.23x | 已用 claude.ai 登入（`claude auth login`）。 |
| **Team/Enterprise 管理者開 Channels**（僅 channel driver） | Team 帳號預設封鎖 channels；等不到的話見下方 headless driver。Owner 需到 claude.ai → Admin settings → Claude Code → Channels 開啟（managed setting `channelsEnabled: true`）。沒開的話 MCP server 會連上、`reply` tool 可用，但 **iPad 訊息不會進 session**，啟動時會看到 "blocked by org policy"。 |
| iPad 與 Mac 同網段（或 Tailscale） | iPad 用 Safari 開 Mac 的 IP。 |
| HTTPS 憑證 | iPad Safari 只在 https 下允許麥克風。見下方。 |

## 安裝

```bash
npm install
npm run cert          # 產生 certs/server.crt，SAN 含 localhost 與 Mac 的 en0 IP
```

憑證存在時，server 會多開一個純 http 的安裝頁在 **port+1**（預設 8791）。iPad Safari 開
`http://<Mac IP>:8791/`，照頁面三步：下載憑證 → 設定 › 一般 › VPN 與裝置管理 › 安裝 →
設定 › 一般 › 關於本機 › 憑證信任設定 › 開啟 `sketchpad` 完全信任。
（不想走這條也可以 AirDrop `certs/server.crt` 過去。）
（有 Tailscale 的話改用 `tailscale cert` 更省事，把 key/crt 放進 `certs/` 即可。）

## 啟動

在這個 repo 目錄：

```bash
claude --dangerously-load-development-channels server:sketch
```

- 第一次會跳「development channels」警告，選 **I am using this for local development**。
- 接著問「New MCP server found in this project: sketch」，選 **Use this MCP server**。
- 啟動 banner 下方應出現 `Channels (experimental) messages from server:sketch inject directly in this session`。

iPad Safari 開 `https://<Mac IP>:8790/`。header 兩個綠點 = server 已連、Claude Code 已接上。

要加一層簡單保護：啟動前 `export SKETCH_TOKEN=xxx`（或寫進 `.mcp.json` 的 `env`），iPad 用 `https://<ip>:8790/?token=xxx`。

## 只測網頁不接 Claude Code

```bash
node server/channel.mjs --standalone
```

回合會存到 `inbox/`，UI 會提示「尚未送進 Claude Code」。

## 驗證 MCP 合約（不需 Claude Code）

```bash
npm run test:mcp
```

用 MCP client 拉起 server、列 tools、POST 一個假回合、確認收到 `notifications/claude/channel`
且 `meta.file_path` 指向存好的 PNG，最後呼叫 `reply` tool。

## 已知限制 / 下一步

- **回合制**：Claude Code 這條路不是串流，體感是「說完 → 等回覆」。要真正邊講邊畫的低延遲，另一條路是走 ADK + Gemini Live bidi。
- **語音辨識走 Safari 的 SpeechRecognition**（Apple 雲端），中文辨識品質一般。可換成 MediaRecorder 串到 server 跑 Whisper。
- **畫布是純 canvas**，只有筆、橡皮、復原、清空。要形狀、選取、讓 Claude 把 SVG 畫回畫布上，下一步換 tldraw。
- 未實作 permission relay：Claude 在 session 卡 permission prompt 時，要回 Mac 按。可在 server 加 `claude/channel/permission` capability 轉發到 iPad。
- `--dangerously-load-development-channels` 是 preview 期間的 flag，語法可能變。

## iPad 原生 app（純手寫板，PencilKit）

`ios/` 是 SwiftUI + PencilKit 的 iPad app，取代網頁版：沒有語音、沒有憑證、Bonjour 自動找到 Mac。

- 系統 PencilKit 工具列：筆、鉛筆、螢光筆、橡皮、套索、尺、色盤；Pencil 壓感與傾斜；雙指縮放的大畫布。
- **回合是一等公民**：每次送出都存下完整筆跡與圖層，右側 Turns 分頁可回看、分支成新頁、匯出、移除 agent 該回合的筆跡。
- **agent 的回覆一律先進預覽佇列**，不會自己動你的畫布：左下角堆卡片，附縮圖，按「Place」或直接把縮圖拖到畫布上決定位置，或關掉（內容留在 Turns）。斷線期間的回覆會在重連時補上。
- 手繪 SVG 落地後是**可編輯筆跡**（逐筆畫出，帶來源標記）；mermaid / draw.io / 生成圖落地後是**圖層**（放在筆跡下方，長按抓取、拖曳、雙指縮放、鎖定、上下層）。
- 多頁畫板（Pages 分頁）：縮圖牆、改名、複製、刪除、agent 可用 `sketchpad_set_title` 建議標題。Media 分頁列出這頁所有的圖，可分享或放成圖層。
- 送出時**上次已送過的筆跡淡成灰色、新筆跡保留原色**（可關）。回合切分三選一：按送出、Pencil 雙擊、停筆 N 秒自動送出。
- 畫圖時 UI 全部淡出、右軌滑出螢幕，抬筆一秒回來。紙張可選空白／點陣／格線。

需求：Xcode 26、iPadOS 17+。專案用 [XcodeGen](https://github.com/yonaskolb/XcodeGen) 產生：

```bash
brew install xcodegen
cd ios && xcodegen generate && open Sketchpad.xcodeproj
```

裝到自己的 iPad：Xcode 裡選 Sketchpad target › Signing & Capabilities › Team 選你的 Apple ID（免費帳號可，7 天要重簽），
接上 iPad 按 Run。第一次 iPad 會問「允許尋找區域網路裝置」，要允許，Bonjour 才找得到 Mac。

Mac 端一樣 `npm run web-only`。app 對 Mac 走 **8791 純 http**（`NSAllowsLocalNetworking`），不需要憑證；
沒被自動找到時到設定手動填 `IP:8791`。模擬器版預設連 `127.0.0.1:8791`。

模擬器編譯（不需要 `sudo xcode-select`，用 `DEVELOPER_DIR` 即可）：

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild -project ios/Sketchpad.xcodeproj -scheme Sketchpad \
  -destination 'platform=iOS Simulator,name=iPad Pro 11-inch (M5)' -derivedDataPath ios/build build CODE_SIGNING_ALLOWED=NO
```

## iPad 當外接手寫板：Sketchpad MCP（推薦）

server 同時是一個**標準 MCP server**（Streamable HTTP，`http://localhost:8791/mcp`）。
對話邏輯完全留在 agent 自己的 session；iPad 只是輸入輸出裝置。不綁 provider：Claude Code、ADK、Codex 都能接。

| tool | 作用 |
| --- | --- |
| `sketchpad_wait_for_turn` | 阻塞直到使用者送出一回合，回傳手寫註記 + 頁面 PNG image block（灰 = 已看過的筆跡，深 = 新筆跡） |
| `sketchpad_get_canvas` | 不等回合，立刻抓一張目前畫布 |
| `sketchpad_show` | 回覆。`svg` → 轉成可編輯筆跡貼在該回合圖片的座標上；`image_path`（mermaid / draw.io / 生成圖的 png/svg）→ iPad 面板顯示，`place_as_layer` 直接放到畫布當可移動圖層 |
| `sketchpad_list_turns` | 這一頁（或全部）的回合清單，含每回合的回覆摘要 |
| `sketchpad_get_turn` | 拿回某一回合的註記與當時的圖 |
| `sketchpad_set_title` | 幫目前頁面命名（使用者改過名之後不再套用） |
| `sketchpad_status` | iPad 是否連線、目前頁面、排隊回合數 |

頂列的狀態點反映**真的有沒有 agent 在等**（有人卡在 `wait_for_turn`），不是 server 狀態。

server 端在 `inbox/turns.json` 保留每回合的紀錄（頁面、時間、圖檔、回覆）。

啟動 server（任何 driver 都有 MCP endpoint；純手寫板用法選 `none`）：

```bash
npm run web-only
```

Claude Code 端，加一次即可在所有專案使用：

```bash
claude mcp add --scope user --transport http sketchpad http://localhost:8791/mcp
```

然後在任何 Claude Code session 說「/sketchpad」或「聽 iPad」。repo 內附 `.claude/skills/sketchpad/SKILL.md`
描述這個 loop；複製到 `~/.claude/skills/` 就能全域使用。ADK 端用 `MCPToolset` 指向同一個 URL。

`wait_for_turn` 預設等 50 秒後回「no turn」讓 agent 再呼叫一次；若 MCP tool timeout 較短可調 `timeout_seconds`。

## 管理者還沒開 Channels？改用 headless driver

Channels 要組織開 `channelsEnabled`。等不到的時候，server 可以自己拉起一個 `claude -p`
（stream-json 進出、stdin 保持開啟做多回合），只需要你現有的 claude.ai 訂閱登入：

```bash
SKETCH_CWD=/path/to/repo-you-want-claude-to-work-in npm run headless
```

差別：這是 server 自己的獨立 session，不是注入你終端機正在用的那個。回覆改由 Claude 的
文字輸出直接轉發到 iPad（不用 `reply` tool），工具呼叫會以 ⚙ 狀態行顯示。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `SKETCH_CWD` | repo 根目錄 | Claude 工作的目錄 |
| `SKETCH_PERMISSION_MODE` | 不帶 | 傳給 `--permission-mode`。沒人能按允許，會提示的工具直接被拒；只看圖回話不需要。要讓它改檔案再設 `acceptEdits`。 |
| `SKETCH_RESUME` | 無 | 給 session id 就接續既有對話 |

三種 driver 一覽：

| driver | 啟動方式 | 需要 |
| --- | --- | --- |
| `channel`（預設） | `claude --dangerously-load-development-channels server:sketch` | 組織開 channels，或個人 Pro/Max 帳號 |
| `headless` | `npm run headless` | 任何 claude.ai 登入 |
| `none` | `npm run web-only` | 無，只測 UI |
