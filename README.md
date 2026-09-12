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
| **Team/Enterprise 管理者開 Channels** | Team 帳號預設封鎖 channels。Owner 需到 claude.ai → Admin settings → Claude Code → Channels 開啟（managed setting `channelsEnabled: true`）。沒開的話 MCP server 會連上、`reply` tool 可用，但 **iPad 訊息不會進 session**，啟動時會看到 "blocked by org policy"。 |
| iPad 與 Mac 同網段（或 Tailscale） | iPad 用 Safari 開 Mac 的 IP。 |
| HTTPS 憑證 | iPad Safari 只在 https 下允許麥克風。見下方。 |

## 安裝

```bash
npm install
npm run cert          # 產生 certs/server.crt，SAN 含 localhost 與 Mac 的 en0 IP
```

把 `certs/server.crt` AirDrop 到 iPad → 設定 › 一般 › VPN 與裝置管理 › 安裝描述檔 →
設定 › 一般 › 關於本機 › 憑證信任設定 › 開啟完全信任。
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
