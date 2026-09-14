<p align="center">
  <img src="docs/logo.svg" width="92" alt="">
</p>

<h1 align="center">Sketchpad</h1>

<p align="center">
  <b>Draw on an iPad. Your coding agent sees the page, answers, and draws back.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/sketchpad-mcp"><img alt="npm" src="https://img.shields.io/npm/v/sketchpad-mcp?color=cb3837&label=npm"></a>
  <img alt="CI" src="https://github.com/yenlianglai/sketchpad/actions/workflows/ci.yml/badge.svg">
  <img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue">
  <img alt="MCP" src="https://img.shields.io/badge/MCP-server-5A45FF">
  <img alt="iPadOS 17+" src="https://img.shields.io/badge/iPadOS-17%2B-black">
  <img alt="Apple Pencil" src="https://img.shields.io/badge/Apple%20Pencil-required-black">
</p>

<p align="center">
  <img src="docs/hero.png" width="620" alt="A wireframe sketched on an iPad, with the agent's reply waiting to be placed on the canvas">
</p>

Some things are faster to draw than to describe. Sketch a layout, press Send, and your agent gets the
page as an image. It answers in kind: a few pen strokes on your drawing, or a diagram dropped in as a
layer you can draw over and send back.

Sketchpad is an MCP server, so your agent keeps its own session, memory and tools.

**You will need** an iPad with an Apple Pencil, and a Mac with Xcode to build the app onto it.

---

## Setup

**1. Install the server and connect your agent.**

```bash
npm install -g sketchpad-mcp
sketchpad install
```

`install` finds the MCP clients on your machine and writes each one's config — merged and backed up
— then starts the server and sets it to start again when you log in. No paths to type, and no
terminal after this.

<details>
<summary>Other ways in</summary>

| Client | |
| --- | --- |
| Claude Desktop | download `sketchpad.mcpb` from [Releases](https://github.com/yenlianglai/sketchpad/releases) and drag it into Settings |
| Claude Code | `claude plugin marketplace add yenlianglai/sketchpad` then `claude plugin install sketchpad@sketchpad` — brings the `/sketchpad` skill with it |
| Cursor · Windsurf · VS Code | `{ "command": "sketchpad-mcp" }` |
| Anything else with MCP | stdio: `sketchpad-mcp` — it finds the server and its token by itself |

`sketchpad status` says what is running, registered and enabled. `sketchpad pair` shows a fresh code,
`sketchpad devices` lists what is paired, `sketchpad revoke <id>` takes one back, and
`sketchpad uninstall` undoes the lot.

</details>

**2. Install the iPad app.** There is no App Store build yet, so you build it once yourself. A free
Apple ID works; it needs re-signing every seven days.

```bash
git clone https://github.com/yenlianglai/sketchpad.git
brew install xcodegen
cd sketchpad/ios && xcodegen generate && open Sketchpad.xcodeproj
```

Pick your team under Signing & Capabilities, plug in the iPad, and press Run.

**3. Pair.** Tap **Pair with a code** and type the eight characters `sketchpad pair` is showing — or
ask your agent for a code and skip the terminal.

**4. Draw.** Say `/sketchpad` to your agent, or just "listen to the iPad".

---

## What you can do

Nothing lands on your canvas by itself. Replies arrive as cards; you place them where you want, or
dismiss them. Strokes the agent has already seen come back greyed out on the next send, so it knows
which marks are new.

- **Strokes** arrive as real pen strokes, drawn one at a time over your sketch. Erase them, lasso
  them, draw over them.
- **Layers** — a rendered diagram, a generated image, or a note the agent wrote — sit under your
  strokes. Long-press to grab, drag to move, pinch to resize, lock to trace.
- **Sheets and turns.** Every send is saved with its strokes, so you can reopen one, export it,
  branch it into a new sheet, or undo just what the agent added that turn.
- **The page keeps going.** It grows downwards and to the right as you fill it, so there is no
  bottom to run into. What gets sent is whatever you drew, not the whole page.

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
| `sketchpad_show` | Reply. `svg` becomes strokes, `image_path` a layer, text on its own a note. |
| `sketchpad_get_canvas` | Snapshot the canvas now, without waiting. |
| `sketchpad_status` | What is connected and who is listening — and a code to read out when nothing is. |

Four, on purpose: receive, answer, look, ask. Every tool is context an agent carries and one more
thing for it to choose wrongly.

The loop an agent follows is in [`.claude/skills/sketchpad/SKILL.md`](.claude/skills/sketchpad/SKILL.md).

| Variable | Default | |
| --- | --- | --- |
| `SKETCHPAD_PORT` | `8791` | Your MCP config carries this port, so the server never moves it on its own. |
| `SKETCHPAD_TOKEN` | generated | Made on first run and kept. Paired iPads get their own keys. |
| `SKETCHPAD_NO_TLS` | off | Serve plain http. Only sane behind something that already encrypts. |
| `SKETCHPAD_URL` | `https://127.0.0.1:8791` | Where the stdio wrapper looks for the running server. |

---

## Worth knowing

- **The agent looks busy while it listens.** `wait_for_turn` blocks, so that session shows as running
  a tool. Almost free in tokens, but you cannot type into it meanwhile — treat it as a mode you
  switch on and off.
- **You can see what you are talking to.** Agents arrive under the name their client gave, and the
  status pill lists them. Disconnect one from there and it stops reaching the iPad, and is told why.
- **One page goes to one agent.** If two are listening, whichever asked first takes it and the other
  keeps waiting — they do not both act on your drawing. `sketchpad_status` names who else is there.
  Hold **Send** to pick one instead; a page addressed that way waits for it rather than being taken
  by whoever happened to be listening.
- **Your drawings live on the iPad.** The Mac forgets a page once it has handed it over, which is why
  looking back needs the iPad awake.
- **Locked and encrypted by default.** Only iPads you have paired can connect, each with its own key;
  the agent's endpoint is not reachable from the network at all; traffic is TLS, pinned at pairing.
  [How that works](CONTRIBUTING.md#pairing) if you want to check it.
- **Local network only.** No relay, no cloud, no account — the iPad talks to your computer and to
  nothing else. That is the same sentence twice: two devices on different networks always need
  something in the middle, so the only way to have nobody in the middle is to be on one network.
  If you need them apart, anything that puts both on one virtual network works — a VPN of your
  choosing. Sketchpad offers every address your computer answers on, including that one.
- **Changing networks is a non-event.** The certificate outlives the address, and the app takes
  whichever address answers, so carrying both devices somewhere else does not mean pairing again.
- **It places diagrams, it does not render them.** Hand it a PNG or SVG and it becomes a layer;
  turning a Mermaid chart into one is the agent's job.

---

A side project, used daily by exactly one person. Issues and patches welcome —
[CONTRIBUTING.md](CONTRIBUTING.md) covers the layout and the tests.

If it saves you some typing, a coffee goes towards the Apple developer account that keeps the iPad
build signed.

[![Buy me a coffee at ko-fi.com](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/N2F026XMI6)

MIT
