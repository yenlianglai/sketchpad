<h1 align="center">Sketchpad</h1>

<p align="center">
  <b>Draw on an iPad. Your coding agent sees the page, answers, and draws back.</b>
</p>

<p align="center">
  <img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-server-5A45FF">
  <img alt="iPadOS 17+" src="https://img.shields.io/badge/iPadOS-17%2B-black">
  <img alt="Apple Pencil" src="https://img.shields.io/badge/Apple%20Pencil-required-black">
</p>

<p align="center">
  <img src="docs/hero.png" width="620" alt="A wireframe sketched on an iPad, with the agent's reply waiting to be placed on the canvas">
</p>

Typing is a bad way to describe a layout, a flow, or a shape. Sketchpad gives your agent a surface
it can actually see: you sketch with an Apple Pencil and press Send, the agent gets the page as an
image, and it answers in the same medium — a few pen strokes on top of your drawing, or a rendered
diagram dropped in as a layer you can draw over and send back.

Your agent keeps its own session, memory and tools. Sketchpad is an MCP server, so it works with
whatever you already use.

---

## Setup

**1. Start the server.** It prints a pairing QR code and listens on port 8791.

```bash
git clone https://github.com/ryanlai/sketchpad.git
cd sketchpad && npm install && npm start
```

**2. Connect your agent.** This detects the MCP clients installed on your machine and writes each
one's config, merged and backed up. No paths to type.

```bash
npm run register -- --write
```

| Client | Also installable as |
| --- | --- |
| Claude Code | `claude plugin marketplace add .` then `claude plugin install sketchpad@sketchpad` — brings the `/sketchpad` skill with it |
| Claude Desktop | `npm run bundle`, then drag `dist/sketchpad.mcpb` into Settings |
| Cursor · Windsurf · VS Code | `{ "command": "sketchpad-mcp" }` after `npm link` |
| Anything else with MCP | stdio: `sketchpad-mcp` · or HTTP: `http://localhost:8791/mcp` |

**3. Install the iPad app.** There is no App Store build, so you sign it yourself. A free Apple ID
works and needs re-signing every seven days.

```bash
brew install xcodegen
cd ios && xcodegen generate && open Sketchpad.xcodeproj
```

Set your team under Signing & Capabilities, plug in the iPad, Run. The app finds your computer over
Bonjour; on a network that blocks it, tap **Scan the QR code** and point the camera at the terminal.

**4. Draw.** Say `/sketchpad` to your agent, or just "listen to the iPad".

---

## What you can do

> *"Here's the onboarding screen. What am I missing?"* — it looks at the sketch and circles the gap
> in your own ink.

> *"Turn this into a state chart."* — it renders one and hands it over as a layer you can trace and
> correct.

> *"What changed since last time?"* — strokes it has already seen come through greyed out, so it can
> see exactly what you added.

<p align="center">
  <img src="docs/layers.png" width="560" alt="A rendered diagram sitting on the canvas as a layer beneath the sketch">
</p>

Nothing the agent sends touches your canvas on its own. Replies queue as cards; you place them
where you want, or dismiss them.

- **Strokes** arrive as real editable pen strokes, placed over your drawing and drawn in one at a
  time. Erase them, lasso them, draw over them.
- **Layers** — a rendered Mermaid or draw.io diagram, or a generated image — sit beneath your
  strokes. Long-press to grab, drag to move, pinch to resize, lock and trace.
- **Sheets and turns.** Every send is kept with its full strokes, so you can reopen one, export it,
  branch it into a new sheet, or remove just the strokes the agent added that turn.

| Gesture | |
| --- | --- |
| Two fingers · three fingers | Undo · redo |
| Two-finger double tap | Fit the page |
| Tap bare canvas | Show or hide the panel |
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
| `sketchpad_list_turns` · `sketchpad_get_turn` | Look back at earlier pages. |
| `sketchpad_set_title` | Name the sheet from what is on it. |
| `sketchpad_status` | Whether an iPad is connected. |

The loop an agent should run is in [`.claude/skills/sketchpad/SKILL.md`](.claude/skills/sketchpad/SKILL.md).

| Variable | Default | |
| --- | --- | --- |
| `SKETCHPAD_PORT` | `8791` | Your registered MCP URL carries this, so the server never moves it silently. |
| `SKETCHPAD_TOKEN` | none | Shared secret. The pairing QR carries it to the iPad. |
| `SKETCHPAD_URL` | `http://127.0.0.1:8791` | Where the stdio wrapper looks for the shared server. |

---

## Worth knowing

- **The agent looks busy while it listens.** `wait_for_turn` blocks, so that session shows as
  running a tool. It costs almost nothing in tokens, but you cannot type into it meanwhile. Treat it
  as a mode you enter and leave.
- **Same network only.** No relay, no cloud. Pages never leave your machine.
- **Rendering is the agent's job.** Sketchpad places a Mermaid or draw.io diagram; it does not draw
  one, so your agent needs its own way to produce an image.

---

This is a side project, used daily by exactly one person. Issues and patches welcome.

MIT
