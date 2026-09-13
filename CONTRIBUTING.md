# Working on Sketchpad

## Layout

```
server/
  index.mjs         wiring: config, the http server, and starting the rest
  hub.mjs           the iPads currently connected — broadcast, clientCount
  state.mjs         turns, replies, snapshots, published files, the manifest
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

## Tests

```bash
npm test           # server: units and two end-to-end suites
npm run test:ios   # the app, in a simulator
```

Four suites, and they are deliberately different shapes:

- `test/state.test.mjs` — the queue, the manifest, replay, the listening light. Pure, fast, no ports.
- `test/tools.test.mjs` — the MCP tools through a real client over an in-memory transport.
- `test/http.test.mjs` — a real server process, a real MCP client, a fake iPad on the WebSocket.
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
Bump the version in `package.json`, `.claude-plugin/plugin.json` and `mcpb/manifest.json` together.
