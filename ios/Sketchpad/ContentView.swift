import SwiftUI
import PencilKit

struct ContentView: View {
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var store: BoardStore
    @EnvironmentObject var conn: ServerConnection
    @StateObject private var canvasController = CanvasController()

    @State private var drawing = PKDrawing()
    @State private var loadedBoardID: UUID?
    @State private var showDrawer = false
    @State private var tab: DrawerTab = .turns
    @State private var unread = 0
    @State private var showSettings = false
    @State private var showScanner = false
    @State private var previewTurn: Turn?
    @State private var selectedLayerID: UUID?
    @State private var layerMode = false
    @State private var sending = false
    @State private var flash: String?
    /// Agent replies wait here until you place or dismiss them; nothing lands on the canvas by itself.
    @State private var replyQueue: [PendingReply] = []
    @State private var dragGhost: (image: UIImage, point: CGPoint, size: CGSize)?
    /// So a reply sent while the iPad was asleep or off the network is picked up on reconnect, once.
    @AppStorage("lastReplyTs") private var lastReplyTs: Double = 0
    @State private var seenReplyIDs: Set<String> = []

    private let railWidth: CGFloat = 48
    private let drawerWidth: CGFloat = 356

    private var newStrokeCount: Int { max(0, drawing.strokes.count - store.current.sentStrokeCount) }
    /// While the pen is down the floating chrome fades. The rail and drawer never move: they sit at
    /// the edge, they are not in the way, and anything that slides off-screen can strand you.
    private var chromeHidden: Bool { canvasController.isDrawing }
    private var rightInset: CGFloat { railWidth + (showDrawer ? drawerWidth : 0) }

    /// Floating chrome over the canvas: it fades while the pen is down.
    private var floatingChrome: some View {
        ZStack(alignment: .topLeading) {
            topBar
            sendButton
            replyCards
        }
        .opacity(chromeHidden ? 0 : 1)
    }

    @ViewBuilder private var connectionCard: some View {
        if settings.host.isEmpty {
            ConnectionCard(discovered: conn.discovered, onPick: { settings.host = $0 }, onScan: { showScanner = true }, onManual: { showSettings = true })
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.trailing, rightInset)
        }
    }

    private var stack: some View {
        ZStack(alignment: .topLeading) {
            canvas
            layerOverlays
            floatingChrome
            sidebar
            connectionCard
        }
    }

    var body: some View {
        stack
        .overlay { ghostOverlay }
        .animation(.easeInOut(duration: 0.22), value: chromeHidden)
        .animation(.spring(duration: 0.28), value: replyQueue)
        .animation(.easeInOut(duration: 0.22), value: showDrawer)
        .animation(.easeInOut(duration: 0.2), value: flash)
        .onAppear { loadCurrentBoard(); wireEvents() }
        .onChange(of: store.currentID) { _, _ in selectedLayerID = nil; loadCurrentBoard() }
        .onChange(of: canvasController.isDrawing) { _, isDrawing in if !layerMode { canvasController.setToolPickerVisible(!isDrawing) } }
        .onChange(of: showDrawer) { _, _ in if !layerMode && !canvasController.isDrawing { canvasController.setToolPickerVisible(true) } }
        .onChange(of: conn.status) { _, s in
            guard s == .connected else { return }
            // First run: start from now rather than replaying the whole history.
            if lastReplyTs == 0 { lastReplyTs = Date().timeIntervalSince1970; return }
            Task { for r in await conn.missedReplies(since: lastReplyTs) { handleReply(r) } }
        }
        .onChange(of: showSettings) { _, shown in if !shown && !layerMode { canvasController.setToolPickerVisible(true) } }
        .sheet(isPresented: $showSettings) { SettingsView(onScan: { showSettings = false; showScanner = true }).environmentObject(settings).environmentObject(conn) }
        .sheet(isPresented: $showScanner) {
            QRScannerSheet { host, token in
                settings.host = host
                if let token { settings.token = token }
                conn.reconnectNow()
                showFlash("Paired with \(host)")
            }
        }
        .sheet(item: $previewTurn) { t in TurnPreview(turn: t, onBranch: { branch(t) }).environmentObject(store) }
    }

    // MARK: pieces

    private var canvas: some View {
        CanvasView(drawing: $drawing, controller: canvasController, pencilOnly: settings.pencilOnly, paper: settings.paper,
                   layers: store.current.layers, layerImage: { store.image(named: $0.file, in: store.layersDir) },
                   onStrokesChanged: strokesChanged,
                   onLayerLongPress: grabLayer)
            .ignoresSafeArea()
    }

    private func grabLayer(_ id: UUID) {
        // A stroke may have started under the press; drop it if it is just a fresh dot.
        if let last = drawing.strokes.last, last.path.count <= 3, drawing.strokes.count > store.current.sentStrokeCount {
            drawing = PKDrawing(strokes: drawing.strokes.dropLast()); strokesChanged()
        }
        setLayerMode(true)
        selectedLayerID = id
        showFlash("Layer grabbed — drag to move, pinch to resize")
    }

    @ViewBuilder private var layerOverlays: some View {
        if layerMode {
            LayerModeOverlay(layers: store.current.layers, selectedID: $selectedLayerID, controller: canvasController, onChange: { store.updateLayer($0) })
                .padding(.trailing, rightInset)
        }
        if let id = selectedLayerID, let layer = store.current.layers.first(where: { $0.id == id }) {
            LayerOverlay(layer: layer, controller: canvasController,
                         onChange: { store.updateLayer($0) },
                         onDelete: { store.removeLayer(id); selectedLayerID = nil },
                         onDone: { selectedLayerID = nil; if store.current.layers.isEmpty { setLayerMode(false) } },
                         onToFront: { reorderLayer(id, toFront: true) },
                         onToBack: { reorderLayer(id, toFront: false) })
                .padding(.trailing, rightInset)
        }
    }

    private func reorderLayer(_ id: UUID, toFront: Bool) {
        var b = store.current
        guard let i = b.layers.firstIndex(where: { $0.id == id }) else { return }
        let l = b.layers.remove(at: i)
        if toFront { b.layers.append(l) } else { b.layers.insert(l, at: 0) }
        store.current = b
    }

    private var sidebar: some View {
        HStack(spacing: 0) {
            if showDrawer {
                Drawer(tab: $tab, actions: drawerActions).frame(width: drawerWidth).transition(.move(edge: .trailing))
            }
            rail.opacity(chromeHidden && !showDrawer ? 0.45 : 1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
    }

    @ViewBuilder private var replyCards: some View {
        if !replyQueue.isEmpty {
            VStack {
                Spacer()
                ReplyQueueView(replies: replyQueue,
                               onPlace: { place($0, at: nil) },
                               onDismiss: { r in withAnimation { replyQueue.removeAll { $0.id == r.id } } },
                               onOpen: { _ in toggleDrawer(.turns) },
                               onDragChanged: ghostFollow,
                               onDragEnded: dropReply)
                    // Clear of the floating PencilKit tool picker along the bottom.
                    .padding(.leading, 20).padding(.bottom, 150)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func ghostFollow(_ r: PendingReply, _ p: CGPoint) {
        guard let img = r.preview else { return }
        let w: CGFloat = 170
        dragGhost = (img, p, CGSize(width: w, height: w * img.size.height / max(1, img.size.width)))
    }

    private var ghostOverlay: some View {
        GeometryReader { g in
            if let ghost = dragGhost {
                let o = g.frame(in: .global).origin
                DragGhost(image: ghost.image, point: CGPoint(x: ghost.point.x - o.x, y: ghost.point.y - o.y), size: ghost.size)
            }
        }
        .ignoresSafeArea().allowsHitTesting(false)
    }

    private func dropReply(_ r: PendingReply, _ p: CGPoint) {
        dragGhost = nil
        guard let canvas = canvasController.canvas else { return }
        let local = canvas.convert(p, from: nil)
        guard local.x < canvas.bounds.width - rightInset else { return }   // dropped on the rail or drawer
        place(r, at: canvasController.canvasPoint(fromView: local))
    }

    // MARK: chrome

    private var topBar: some View {
        HStack(spacing: 10) {
            Menu {
                ForEach(store.boardsByRecency.prefix(8)) { b in Button(b.title) { store.currentID = b.id } }
                Divider()
                Button { store.newBoard() } label: { Label("New page", systemImage: "plus") }
                Button { showDrawer = true; tab = .pages } label: { Label("All pages…", systemImage: "square.grid.2x2") }
            } label: {
                HStack(spacing: 10) {
                    Circle().fill(conn.status == .connected ? (conn.agentListening ? Color.green : Color.orange) : Color.red).frame(width: 8, height: 8)
                    Text(store.current.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Text(statusText).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Image(systemName: "chevron.down").font(.caption2).foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16).frame(height: 44).background(.thinMaterial, in: Capsule())
            }
            .buttonStyle(.plain)
            chromeButton("arrow.uturn.backward") { canvasController.undo() }
            chromeButton("arrow.uturn.forward") { canvasController.redo() }
            if !store.current.layers.isEmpty || layerMode {
                Button { setLayerMode(!layerMode) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "square.on.square.dashed").font(.body.weight(.medium))
                        Text(layerMode ? "Layers · done" : "Layers").font(.subheadline.weight(.semibold))
                    }
                    .padding(.horizontal, 16).frame(height: 44)
                    .background(layerMode ? Color.primary : Color.clear, in: Capsule())
                    .background(.thinMaterial, in: Capsule())
                    .foregroundStyle(layerMode ? Color(uiColor: .systemBackground) : .primary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 20).padding(.top, 20)
    }

    private func setLayerMode(_ on: Bool) {
        layerMode = on
        canvasController.isDrawing = false
        canvasController.setDrawingEnabled(!on)
        if !on { selectedLayerID = nil }
        else if selectedLayerID == nil, let last = store.current.layers.last { selectedLayerID = last.id }
    }

    private var statusText: String {
        if sending { return "sending…" }
        switch conn.status {
        case .connected:
            if store.currentTurns.last?.taken == true, store.currentTurns.last?.agentText == nil { return "agent reading…" }
            return conn.agentListening ? "agent listening" : "nobody listening"
        case .connecting: return "connecting…"
        case .disconnected: return "offline"
        }
    }

    private func chromeButton(_ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: { canvasController.isDrawing = false; action() }) { Image(systemName: symbol).font(.body.weight(.medium)).frame(width: 44, height: 44).background(.thinMaterial, in: Circle()) }
            .buttonStyle(.plain).foregroundStyle(.primary)
    }

    private var rail: some View {
        VStack(spacing: 14) {
            railButton("sidebar.trailing", on: showDrawer && tab == .turns, badge: unread) { toggleDrawer(.turns) }
            railButton("photo.on.rectangle", on: showDrawer && tab == .media) { toggleDrawer(.media) }
            railButton("doc.on.doc", on: showDrawer && tab == .pages) { toggleDrawer(.pages) }
            Spacer()
            railButton("gearshape") { showSettings = true }
        }
        .padding(.top, 20).padding(.bottom, 20)
        .frame(width: railWidth).frame(maxHeight: .infinity)
        .background(.regularMaterial)
        .overlay(alignment: .leading) { Divider() }
    }

    private func railButton(_ symbol: String, on: Bool = false, badge: Int = 0, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.body.weight(.medium))
                .frame(width: 34, height: 34)
                .background(on ? Color.primary : Color.clear, in: RoundedRectangle(cornerRadius: 11))
                .foregroundStyle(on ? Color(uiColor: .systemBackground) : Color.secondary)
                .overlay(alignment: .topTrailing) {
                    if badge > 0 {
                        Text("\(badge)").font(.system(size: 10, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 4).frame(minWidth: 17, minHeight: 17)
                            .background(Color(uiColor: Settings.agentColor), in: Capsule()).overlay(Capsule().stroke(.white, lineWidth: 2))
                            .offset(x: 6, y: -6)
                    }
                }
        }.buttonStyle(.plain)
    }

    private func toggleDrawer(_ t: DrawerTab) {
        canvasController.isDrawing = false
        if showDrawer && tab == t { showDrawer = false } else { tab = t; showDrawer = true }
        if t == .turns { unread = 0 }
    }

    private var sendButton: some View {
        GeometryReader { geo in
        VStack { Spacer()
            HStack { Spacer()
                Button { Task { await send() } } label: {
                    HStack(spacing: 10) {
                        if sending { ProgressView().tint(.white) } else { Image(systemName: "paperplane.fill") }
                        Text("Send").font(.headline)
                        if newStrokeCount > 0 {
                            Text("\(newStrokeCount)").font(.caption.bold()).padding(.horizontal, 7).frame(minWidth: 24, minHeight: 24).background(.white.opacity(0.22), in: Capsule())
                        }
                    }
                    .foregroundStyle(.white).padding(.horizontal, 22).frame(height: 56)
                    .background(Color.black, in: Capsule()).shadow(color: .black.opacity(0.22), radius: 12, y: 8)
                }
                .buttonStyle(.plain)
                .disabled(sending || (drawing.strokes.isEmpty && store.current.layers.isEmpty))
                // The floating PencilKit picker spans most of a narrow (portrait) width; keep Send above it there.
                .padding(.trailing, rightInset + 24).padding(.bottom, geo.size.width - rightInset < 1000 ? 130 : 28)
            }
        }
        }
    }

    private func toast(_ s: String) -> some View {
        VStack { Spacer()
            Text(s).font(.callout.weight(.medium)).padding(.horizontal, 14).padding(.vertical, 9).background(.thinMaterial, in: Capsule())
                .padding(.bottom, 110)
        }.frame(maxWidth: .infinity).padding(.trailing, rightInset).transition(.opacity)
    }

    // MARK: board & strokes

    private func loadCurrentBoard() {
        guard loadedBoardID != store.currentID else { return }
        loadedBoardID = store.currentID
        drawing = store.current.drawing
    }

    private func strokesChanged() {
        var b = store.current
        b.drawing = drawing
        b.sentStrokeCount = min(b.sentStrokeCount, drawing.strokes.count)
        store.current = b
    }

    private func layerImage(_ l: Layer) -> UIImage? { store.image(named: l.file, in: store.layersDir) }

    private func renderCurrent(highlight: Bool) -> TurnRenderer.Output? {
        TurnRenderer.render(drawing, layers: store.current.layers, layerImage: layerImage, sentStrokeCount: store.current.sentStrokeCount, highlightNew: highlight)
    }

    private func send() async { await sendTurn() }

    // MARK: send

    @MainActor
    private func sendTurn() async {
        guard !sending else { return }
        // Strokes the agent has already seen are greyed out so the new ones stand out; always on.
        guard let out = renderCurrent(highlight: true) else { return }
        sending = true
        defer { sending = false }
        let board = store.current
        do {
            let turnId = try await conn.sendTurn(png: out.png, text: "", newStrokes: newStrokeCount, boardId: board.id, boardTitle: board.title)
            let t = Turn(id: turnId, boardID: board.id, note: "", newStrokes: newStrokeCount, drawingData: drawing.dataRepresentation(), layers: board.layers,
                         pngFile: nil, imageBounds: out.bounds, imageScale: out.scale)
            store.addTurn(t, png: out.png)
            var b = store.current; b.sentStrokeCount = drawing.strokes.count; store.current = b
            showFlash(conn.agentReady ? "Sent to agent" : "Sent · no agent listening yet")
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } catch {
            showFlash("Send failed: \(error.localizedDescription)")
        }
    }

    private func showFlash(_ s: String) {
        flash = s
        Task { try? await Task.sleep(nanoseconds: 1_800_000_000); if flash == s { flash = nil } }
    }

    // MARK: events from the agent

    private func wireEvents() {
        conn.onEvent = { ev in
            switch ev {
            case .reply(let r): handleReply(r)
            case .taken(let id): store.update(id) { $0.taken = true }
            case .title(let boardId, let title):
                var b = store.current
                if let bid = boardId, let uuid = UUID(uuidString: bid), uuid != b.id, let other = store.board(uuid) { if !other.titleLocked { store.rename(uuid, to: title) }; return }
                if !b.titleLocked { b.title = title; store.current = b; showFlash("Page titled “\(title)”") }
            case .snapshotRequest(let id): conn.postSnapshot(id: id, png: renderCurrent(highlight: false)?.png)
            case .system(let s): showFlash(s)
            }
        }
    }

    private func handleReply(_ r: Reply) {
        guard !seenReplyIDs.contains(r.id) else { return }
        seenReplyIDs.insert(r.id)
        if r.ts > lastReplyTs { lastReplyTs = r.ts }

        var turnId = r.turnId.flatMap { id in store.turn(id) != nil ? id : nil } ?? store.currentTurns.last?.id
        if turnId == nil {
            // Agent spoke first: anchor the reply to a synthetic turn on the current page, in the visible area.
            let vis = canvasController.visibleCanvasRect
            let t = Turn(id: "agent-" + UUID().uuidString.prefix(8).lowercased(), boardID: store.currentID, note: "", newStrokes: 0,
                         drawingData: drawing.dataRepresentation(), layers: store.current.layers, pngFile: nil, imageBounds: vis, imageScale: 1, taken: true, agentInitiated: true)
            store.addTurn(t, png: nil)
            turnId = t.id
        }
        guard let turnId, let turn = store.turn(turnId) else { showFlash(r.text); return }
        if !r.text.isEmpty { store.update(turnId) { $0.agentText = ($0.agentText.map { $0 + "\n" } ?? "") + r.text; $0.taken = true } }
        if !(showDrawer && tab == .turns) { unread += 1 }

        // A text-only reply is its own card; otherwise the text rides on the first file's card.
        var textForCard = r.text
        if r.files.isEmpty {
            if !r.text.isEmpty { replyQueue.append(PendingReply(turnId: turnId, itemId: UUID(), kind: "text", text: r.text)) }
            return
        }

        for f in r.files {
            let item = AgentItem(kind: f.kind, svg: f.svg, file: nil, remoteURL: f.remoteURL?.absoluteString, wantsLayer: f.layer)
            store.update(turnId) { $0.agentItems.append(item) }
            let cardText = textForCard; textForCard = ""

            if f.kind == "sketch" {
                let preview = f.svg.flatMap { SVGStrokes.preview(svg: $0, maxSize: CGSize(width: 276, height: 150)) }
                replyQueue.append(PendingReply(turnId: turnId, itemId: item.id, kind: "sketch", text: cardText, preview: preview, suggested: true))
            } else if let url = f.remoteURL {
                let ext = (f.name as NSString).pathExtension.isEmpty ? "png" : (f.name as NSString).pathExtension
                let name = "\(item.id.uuidString).\(ext)"
                let card = PendingReply(turnId: turnId, itemId: item.id, kind: f.kind, text: cardText, downloading: true, suggested: f.layer)
                replyQueue.append(card)
                Task {
                    do {
                        try await conn.download(url, to: store.agentFileURL(name))
                        store.update(turnId) { t in if let i = t.agentItems.firstIndex(where: { $0.id == item.id }) { t.agentItems[i].file = name } }
                        let img = store.image(named: name, in: store.agentDir)
                        if let i = replyQueue.firstIndex(where: { $0.id == card.id }) {
                            replyQueue[i].downloading = false
                            replyQueue[i].preview = img
                            replyQueue[i].failed = img == nil
                        }
                    } catch {
                        if let i = replyQueue.firstIndex(where: { $0.id == card.id }) { replyQueue[i].downloading = false; replyQueue[i].failed = true }
                    }
                }
            }
        }
    }

    /// Accept one queued reply: strokes join the drawing, images become a layer. `at` is the canvas
    /// point you dropped it on; nil means the agent's own placement (aligned with the turn image).
    private func place(_ reply: PendingReply, at point: CGPoint?) {
        guard let turn = store.turn(reply.turnId), let item = turn.agentItems.first(where: { $0.id == reply.itemId }) else { return }
        guard turn.boardID == store.currentID else { showFlash("That reply belongs to another page"); return }
        if reply.kind == "sketch" { placeSketch(turn: turn, item: item, at: point, announce: true) }
        else { placeLayer(turn: turn, item: item, at: point) }
        withAnimation { replyQueue.removeAll { $0.id == reply.id } }
    }

    // MARK: placing agent output

    /// Convert the agent's SVG into pen strokes aligned with the turn's image, appended one by one.
    private func placeSketch(turn: Turn, item: AgentItem, at point: CGPoint? = nil, announce: Bool) {
        guard let svg = item.svg, turn.boardID == store.currentID else { return }
        let mapping = SVGStrokeMapping(origin: turn.imageBounds.origin, pixelsPerPoint: turn.imageScale, viewBox: nil, imageSize: CGSize(width: turn.imageBounds.width * turn.imageScale, height: turn.imageBounds.height * turn.imageScale))
        let base = Date()
        var strokes = SVGStrokes.strokes(from: svg, mapping: mapping, defaultColor: Settings.agentColor, baseDate: base)
        guard !strokes.isEmpty else { if announce { showFlash("Nothing in the agent's SVG could become strokes") }; return }
        if let point {
            // Dropped somewhere specific: move the whole group so its centre lands there.
            let b = PKDrawing(strokes: strokes).bounds
            let d = CGPoint(x: point.x - b.midX, y: point.y - b.midY)
            strokes = strokes.map { s in var s = s; s.transform = s.transform.concatenating(CGAffineTransform(translationX: d.x, y: d.y)); return s }
        }
        let before = drawing
        let dates = strokes.map { $0.path.creationDate.timeIntervalSince1970 }
        store.recordAgentStrokes(turnId: turn.id, dates: dates)
        store.update(turn.id) { t in if let i = t.agentItems.firstIndex(where: { $0.id == item.id }) { t.agentItems[i].strokeDates += dates } }
        Task { @MainActor in
            for s in strokes {
                drawing.append(PKDrawing(strokes: [s]))
                try? await Task.sleep(nanoseconds: 45_000_000)
            }
            strokesChanged()
            canvasController.canvas?.undoManager?.registerUndo(withTarget: canvasController) { _ in
                Task { @MainActor in self.drawing = before; self.strokesChanged() }
            }
            if announce { showFlash("Agent drew \(strokes.count) strokes — erase, move, or draw over them") }
        }
    }

    /// Put an agent image onto the canvas as a layer, sized to fit the visible area, below the drawing when possible.
    private func placeLayer(turn: Turn, item: AgentItem, at point: CGPoint? = nil) {
        guard let file = item.file, let img = store.image(named: file, in: store.agentDir) else { showFlash("Image not downloaded yet"); return }
        // The canvas runs under the rail/drawer; only the uncovered part counts as visible.
        var visible = canvasController.visibleCanvasRect
        visible.size.width = max(200, visible.width - rightInset / canvasController.zoom)
        let maxW = visible.width * 0.6, maxH = visible.height * 0.6
        var w = img.size.width / 2, h = img.size.height / 2
        let k = min(1, min(maxW / w, maxH / h)); w *= k; h *= k
        var origin = CGPoint(x: visible.midX - w / 2, y: visible.midY - h / 2)
        if let point { origin = CGPoint(x: point.x - w / 2, y: point.y - h / 2) }
        else if !drawing.strokes.isEmpty, drawing.bounds.maxY + 40 + h < visible.maxY { origin = CGPoint(x: max(visible.minX + 20, drawing.bounds.minX), y: drawing.bounds.maxY + 40) }
        guard let layer = store.addLayer(fromAgentFile: file, kind: item.kind, turnId: turn.id, frame: CGRect(origin: origin, size: CGSize(width: w, height: h))) else { return }
        store.update(turn.id) { t in if let i = t.agentItems.firstIndex(where: { $0.id == item.id }) { t.agentItems[i].placedAsLayer = true } }
        setLayerMode(true)
        selectedLayerID = layer.id
        showFlash("\(item.kind) placed — drag to move, pinch or corners to resize, tap Layers · done to draw")
    }

    private func branch(_ t: Turn) {
        let b = store.branch(from: t)
        showFlash("Branched into “\(b.title)”")
    }

    private var drawerActions: DrawerActions {
        DrawerActions(
            placeSketch: { t, i in placeSketch(turn: t, item: i, announce: true) },
            placeLayer: { t, i in placeLayer(turn: t, item: i, at: nil) },
            branch: branch,
            preview: { previewTurn = $0 },
            removeAgentStrokes: { t in store.removeAgentStrokes(turnId: t.id, from: &drawing); showFlash("Removed the agent's strokes from that turn") },
            openBoard: { store.currentID = $0 },
            newBoard: { store.newBoard() },
            flash: showFlash)
    }
}
