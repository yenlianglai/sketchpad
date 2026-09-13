<p align="center">
  <img src="docs/logo.svg" width="92" alt="">
</p>

<h1 align="center">Sketchpad</h1>

<p align="center">
  <b>Draw on an iPad. Your coding agent sees the page, answers, and draws back.</b>
</p>

<p align="center">
  <img alt="CI" src="https://github.com/yenlianglai/sketchpad/actions/workflows/ci.yml/badge.svg">
  <img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-server-5A45FF">
  <img alt="iPadOS 17+" src="https://img.shields.io/badge/iPadOS-17%2B-black">
  <img alt="Apple Pencil" src="https://img.shields.io/badge/Apple%20Pencil-required-black">
</p>

Some things are faster to draw than to describe. Sketch a layout, press Send, and your agent gets
the page as an image. It answers in kind: a few pen strokes on your drawing, or a diagram dropped in
as a layer you can draw over and send back.

Sketchpad is an MCP server, so your agent keeps its own session, memory and tools.

**You will need** an iPad with an Apple Pencil, and a Mac with Xcode — there is no App Store build
yet, so you sign the app yourself.

---

## Setup

**1. Start the server.** It prints a pairing QR code and listens on port 8791.

```bash
git clone https://github.com/yenlianglai/sketchpad.git
cd sketchpad && npm install && npm start
```

**2. Connect your agent.** This finds the MCP clients on your machine and writes each one's config,
merged and backed up. No paths to type.

```bash
npm run register -- --write
```

<details>
<summary>Or install it yourself</summary>

| Client | |
| --- | --- |
| Claude Code | `claude plugin marketplace add .` then `claude plugin install sketchpad@sketchpad` — brings the `/sketchpad` skill with it |
| Claude Desktop | `npm run bundle`, then drag `dist/sketchpad.mcpb` into Settings |
| Cursor · Windsurf · VS Code | `{ "command": "sketchpad-mcp" }` after `npm link` |
| Anything else with MCP | stdio: `sketchpad-mcp` · or HTTP: `http://localhost:8791/mcp` |

</details>

**3. Install the iPad app.** A free Apple ID works; it needs re-signing every seven days.

```bash
brew install xcodegen
cd ios && xcodegen generate && open Sketchpad.xcodeproj
```

Pick your team under Signing & Capabilities, plug in the iPad, Run. The app finds your computer over
Bonjour; if your network blocks that, tap **Scan the QR code** and point the camera at the terminal.

**4. Draw.** Say `/sketchpad` to your agent, or just "listen to the iPad".

---

## What you can do

<p align="center">
  <img src="docs/hero.png" width="620" alt="A wireframe sketched on an iPad, with the agent's reply waiting to be placed on the canvas">
</p>

Nothing lands on your canvas by itself. Replies arrive as cards, like the one above — place them
where you want, or dismiss them. Strokes the agent has already seen come back greyed out on the next
send, so it can see what changed.

- **Strokes** come in as real pen strokes, drawn on one at a time over your sketch. Erase them,
  lasso them, draw over them.
- **Layers** — a rendered diagram or a generated image — sit under your strokes. Long-press to grab,
  drag to move, pinch to resize, lock to trace.
- **Sheets and turns.** Every send is saved with its strokes, so you can reopen one, export it,
  branch it into a new sheet, or undo just what the agent added that turn.

<p align="center">
  <img src="docs/layers.png" width="560" alt="A rendered diagram sitting on the canvas as a layer beneath the sketch">
</p>

| Gesture | |
| --- | --- |
| Two fingers · three fingers | Undo · redo |
| Two-finger double tap | Fit the page |
| Tap bare canvas | Dismiss the panel |
| Long-press a layer | Grab it, then drag or pinch |
| Drop an image | Becomes a layer — drop a screenshot in and annotate it |

With a keyboard: `⌘↩` send, `⌘N` new sheet, `⌘\` panel, `⌘0` fit.

---

## Tools

| Tool | |
| --- | --- |
| `sketchpad_wait_for_turn` | Wait for a page. Returns the note and the page as an image. |
| `sketchpad_show` | Reply. `svg` becomes strokes on the canvas, `image_path` becomes a layer. |
| `sketchpad_get_canvas` | Snapshot the canvas now, without waiting. |
| `sketchpad_list_turns` · `sketchpad_get_turn` | Look back at earlier pages. Needs the iPad awake. |
| `sketchpad_set_title` | Name the sheet from what is on it. |
| `sketchpad_status` | Whether an iPad is connected. |

The loop an agent follows is in [`.claude/skills/sketchpad/SKILL.md`](.claude/skills/sketchpad/SKILL.md).

Three environment variables worth knowing:

| Variable | Default | |
| --- | --- | --- |
| `SKETCHPAD_PORT` | `8791` | Your MCP config carries this port, so the server never moves it on its own. |
| `SKETCHPAD_TOKEN` | generated | A token is made on first run and kept. The pairing QR carries it. |
| `SKETCHPAD_URL` | `http://127.0.0.1:8791` | Where the stdio wrapper looks for the running server. |

---

## Worth knowing

- **The agent looks busy while it listens.** `wait_for_turn` blocks, so that session shows as
  running a tool. It costs almost nothing in tokens, but you cannot type into it meanwhile. Treat it
  as a mode you switch on and off.
- **Your drawings live on the iPad.** The Mac keeps nothing — it passes a page to the agent, then
  forgets it. That is why looking back at old pages needs the iPad awake.
- **Locked by default.** A token is generated on first run, so only a device that scanned your QR
  can connect. The agent's own endpoint is not reachable from the network at all.
- **Same network only.** No relay, no cloud, no account.
- **Sketchpad places diagrams, it does not render them.** Give it a PNG or SVG and it becomes a
  layer; an agent that wants to send a Mermaid chart needs its own way to turn one into an image.

---

A side project, used daily by exactly one person. Issues and patches welcome —
[CONTRIBUTING.md](CONTRIBUTING.md) covers the layout and the tests.

If it saves you some typing, [buy me a coffee](https://ko-fi.com/ryanlai880122) — it goes towards the
Apple developer account that keeps the iPad build signed.

MIT
