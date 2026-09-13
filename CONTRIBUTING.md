# Working on Sketchpad

## Layout

```
server/
  index.mjs         wiring: config, the http server, and starting the rest
  hub.mjs           the iPads currently connected — broadcast, clientCount
  state.mjs         what is in flight: the queue, questions for the iPad, the spool
  tools.mjs         the seven MCP tools, over state
  routes.mjs        the http surface, including /mcp
  pairing.mjs       Bonjour and the terminal QR
  mcp-stdio.mjs     stdio entry point; finds or starts the shared server
  plugin-entry.mjs  the same, with a dependency install for plugin installs
ios/
  Sketchpad/        the app
  SketchpadTests/   unit tests
scripts/register.mjs   writes MCP client configs
test/                  server tests
```

`state.mjs` knows nothing about MCP or HTTP, and `tools.mjs` knows nothing about sockets. That is
what makes both testable without starting anything.

**The iPad is the only store.** The server keeps nothing you drew: a page waits in memory until an
agent takes it, a handed-over file and an undelivered reply sit in `~/Library/Caches/sketchpad`
until collected, and everything there is dropped after a day. When an agent looks back —
`list_turns`, `get_turn` — the server asks the iPad over the WebSocket and the iPad answers from its
own `Documents`. So those tools need the iPad awake, and deleting the cache loses nothing.

## Running it

```bash
npm install
npm start          # server on 8791, prints a pairing QR
npm run app        # generate and open the Xcode project
```

Useful environment variables while developing:

| | |
| --- | --- |
| `SKETCHPAD_PORT` | Move the port. The iPad follows over Bonjour; a registered MCP URL does not. |
| `SKETCHPAD_QUIET=1` | No banner, no request log. Used by the tests. |
| `SKETCHPAD_NO_BONJOUR=1` | Do not advertise. Used by the tests and by CI. |
| `SKETCHPAD_TOKEN` | Require a token. The pairing QR carries it. |
| `SKETCHPAD_SPOOL_DIR` | Move the in-flight cache. Used by the tests. |

## Tests

```bash
npm test           # server: units and two end-to-end suites
npm run test:ios   # the app, in a simulator
```

Four suites, and they are deliberately different shapes:

- `test/state.test.mjs` — the queue, asking the iPad, the spool, the listening light. Pure, no ports.
- `test/tools.test.mjs` — the MCP tools through a real client over an in-memory transport.
- `test/http.test.mjs` — a real server process, a real MCP client, a stand-in iPad on the WebSocket.
- `test/stdio.test.mjs` — the wrapper, spawned the way a desktop client spawns it.
- `ios/SketchpadTests` — the two pure functions that fail silently when they are wrong: the
  SVG-to-strokes parser and the pairing-QR parser.

The rule of thumb: anything whose failure is **silent** gets a unit test. Views and gestures do not,
because a broken one is obvious the moment you look.

Both suites run on every push. CI also packs the Claude Desktop bundle, so a release never discovers
a broken manifest.

## Changing the agent-facing surface

The tool descriptions in `server/tools.mjs` are the API: an agent behaves according to what they say.
When you change behaviour, change the description in the same commit, and check
`.claude/skills/sketchpad/SKILL.md` still matches — that file is the loop an agent follows.

`test/tools.test.mjs` asserts that every tool in `TOOLS` is actually offered, so adding one without
wiring it up fails.

## Releasing

Tag `vX.Y.Z`. CI runs the tests, packs `dist/sketchpad.mcpb`, and attaches it to the release.
Bump the version in `package.json`, `.claude-plugin/plugin.json` and `manifest.json` together.

## Brand

One stroke that starts as your ink and finishes as the agent's. Ink `#1C1C1E`, agent `#C7552B`,
paper white — the accent appears only where the agent has touched something.

`docs/logo.svg` is the mark on its own; `docs/icon.svg` is the full-bleed app icon it is cut from.
The iPad icon set in `ios/Sketchpad/Assets.xcassets` is rendered from that SVG:

```bash
for px in 20 29 40 58 76 80 152 167 1024; do
  rsvg-convert -w $px -h $px -o ios/Sketchpad/Assets.xcassets/AppIcon.appiconset/icon-$px.png docs/icon.svg
done
```
