import SwiftUI
import PencilKit

struct ContentView: View {
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var store: BoardStore
    @EnvironmentObject var conn: ServerConnection
    @StateObject var canvasController = CanvasController()

    @State var drawing = PKDrawing()
    @State var loadedBoardID: UUID?
    @State var showDrawer = false
    @State var tab: DrawerTab = .turns
    @State var unread = 0
    @State var showSettings = false
    @State var showPairing = false
    @State var showAgents = false
    @State var previewTurn: Turn?
    @State var selectedLayerID: UUID?
    @State var layerMode = false
    @State var sending = false
    @State var flash: String?
    /// Agent replies wait here until you place or dismiss them; nothing lands on the canvas by itself.
    @State var replyQueue: [PendingReply] = []
    @State var dragGhost: (image: UIImage, point: CGPoint, size: CGSize)?
    /// So a reply sent while the iPad was asleep or off the network is picked up on reconnect, once.
    @AppStorage("lastReplyTs") var lastReplyTs: Double = 0
    @State var seenReplyIDs: Set<String> = []

    let railWidth: CGFloat = 48
    let drawerWidth: CGFloat = 356

    var newStrokeCount: Int { max(0, drawing.strokes.count - store.current.sentStrokeCount) }
    /// While the pen is down the floating chrome fades. The rail and drawer never move: they sit at
    /// the edge, they are not in the way, and anything that slides off-screen can strand you.
    var chromeHidden: Bool { canvasController.isDrawing }
    var rightInset: CGFloat { railWidth + (showDrawer ? drawerWidth : 0) }

    /// Floating chrome over the canvas: it fades while the pen is down.
    var floatingChrome: some View {
        ZStack(alignment: .topLeading) {
            topBar
            sendButton
            replyCards
        }
        .opacity(chromeHidden ? 0 : 1)
    }

    @ViewBuilder var connectionCard: some View {
        if settings.host.isEmpty {
            ConnectionCard(discovered: conn.discovered, onPick: { settings.host = $0 }, onPair: { showPairing = true }, onManual: { showSettings = true })
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(.trailing, rightInset)
        }
    }

    var stack: some View {
        ZStack(alignment: .topLeading) {
            canvas
            layerOverlays
            floatingChrome
            sidebar
            connectionCard
            shortcuts
        }
    }

    /// Hardware-keyboard shortcuts, for an iPad in a Magic Keyboard.
    var shortcuts: some View {
        ZStack {
            Button("New sheet") { store.newBoard() }.keyboardShortcut("n", modifiers: .command)
            Button("Toggle panel") { toggleDrawer(tab) }.keyboardShortcut("\\", modifiers: .command)
            Button("Fit page") { canvasController.zoomToFit(layers: store.current.layers) }.keyboardShortcut("0", modifiers: .command)
        }
        .opacity(0).frame(width: 0, height: 0)
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
        .sheet(isPresented: $showSettings) { SettingsView(onPair: { showSettings = false; showPairing = true }).environmentObject(settings).environmentObject(conn) }
        .sheet(isPresented: $showPairing) {
            PairingSheet().environmentObject(settings).environmentObject(conn)
        }
        .sheet(isPresented: $showAgents) { AgentsView().environmentObject(conn) }
        .sheet(item: $previewTurn) { t in TurnPreview(turn: t, onBranch: { branch(t) }).environmentObject(store) }
    }

    // MARK: pieces

    var canvas: some View {
        CanvasView(drawing: $drawing, controller: canvasController, pencilOnly: settings.pencilOnly, paper: settings.paper,
                   layers: store.current.layers, layerImage: { store.image(named: $0.file, in: store.layersDir) },
                   onStrokesChanged: strokesChanged,
                   onLayerLongPress: grabLayer,
                   // Tapping bare canvas only gets the panel out of the way. Opening it is a
                   // deliberate act: tap the rail. Otherwise every stray tap pops it open.
                   onTapEmpty: { if showDrawer && !layerMode { showDrawer = false } },
                   onDropImage: dropImage)
            .ignoresSafeArea()
            .overlay { if drawing.strokes.isEmpty && store.current.layers.isEmpty { emptyHint } }
    }

    /// A blank sheet should say what to do with it.
    var emptyHint: some View {
        VStack(spacing: 6) {
            Text("Draw here").font(.title3.weight(.semibold)).foregroundStyle(.secondary)
            Text("Send when you want the agent to look.\nTwo fingers to undo, three to redo.")
                .font(.subheadline).foregroundStyle(.tertiary).multilineTextAlignment(.center)
        }
        .padding(.trailing, rightInset)
        .allowsHitTesting(false)
    }

    func dropImage(_ image: UIImage, at point: CGPoint) {
        let maxW = min(520, canvasController.visibleCanvasRect.width * 0.6)
        let w = min(maxW, image.size.width / 2)
        let h = w * image.size.height / max(1, image.size.width)
        guard let layer = store.addLayer(image: image, frame: CGRect(x: point.x - w / 2, y: point.y - h / 2, width: w, height: h)) else { return }
        setLayerMode(true)
        selectedLayerID = layer.id
        showFlash("Dropped in — drag to move, pinch to resize")
    }

    func grabLayer(_ id: UUID) {
        // A stroke may have started under the press; drop it if it is just a fresh dot.
        if let last = drawing.strokes.last, last.path.count <= 3, drawing.strokes.count > store.current.sentStrokeCount {
            drawing = PKDrawing(strokes: drawing.strokes.dropLast()); strokesChanged()
        }
        setLayerMode(true)
        selectedLayerID = id
        showFlash("Layer grabbed — drag to move, pinch to resize")
    }

    @ViewBuilder var layerOverlays: some View {
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

    func reorderLayer(_ id: UUID, toFront: Bool) {
        var b = store.current
        guard let i = b.layers.firstIndex(where: { $0.id == id }) else { return }
        let l = b.layers.remove(at: i)
        if toFront { b.layers.append(l) } else { b.layers.insert(l, at: 0) }
        store.current = b
    }

    var sidebar: some View {
        HStack(spacing: 0) {
            if showDrawer {
                Drawer(tab: $tab, actions: drawerActions).frame(width: drawerWidth).transition(.move(edge: .trailing))
            }
            rail.opacity(chromeHidden && !showDrawer ? 0.45 : 1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .trailing)
    }

    @ViewBuilder var replyCards: some View {
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

    func ghostFollow(_ r: PendingReply, _ p: CGPoint) {
        guard let img = r.preview else { return }
        let w: CGFloat = 170
        dragGhost = (img, p, CGSize(width: w, height: w * img.size.height / max(1, img.size.width)))
    }

    var ghostOverlay: some View {
        GeometryReader { g in
            if let ghost = dragGhost {
                let o = g.frame(in: .global).origin
                DragGhost(image: ghost.image, point: CGPoint(x: ghost.point.x - o.x, y: ghost.point.y - o.y), size: ghost.size)
            }
        }
        .ignoresSafeArea().allowsHitTesting(false)
    }

    func dropReply(_ r: PendingReply, _ p: CGPoint) {
        dragGhost = nil
        guard let canvas = canvasController.canvas else { return }
        let local = canvas.convert(p, from: nil)
        guard local.x < canvas.bounds.width - rightInset else { return }   // dropped on the rail or drawer
        place(r, at: canvasController.canvasPoint(fromView: local))
    }

    // MARK: chrome

    var topBar: some View {
        HStack(spacing: 10) {
            Menu {
                ForEach(store.boardsByRecency.prefix(8)) { b in Button(b.title) { store.currentID = b.id } }
                Divider()
                Button { store.newBoard() } label: { Label("New page", systemImage: "plus") }
                Button { showDrawer = true; tab = .pages } label: { Label("All pages…", systemImage: "square.grid.2x2") }
                Divider()
                Button { showAgents = true } label: {
                    Label(conn.agents.isEmpty ? "Agents…" : "Agents (\(conn.agents.count))…", systemImage: "antenna.radiowaves.left.and.right")
                }
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

    func setLayerMode(_ on: Bool) {
        layerMode = on
        canvasController.isDrawing = false
        canvasController.setDrawingEnabled(!on)
        if !on { selectedLayerID = nil }
        else if selectedLayerID == nil, let last = store.current.layers.last { selectedLayerID = last.id }
    }

    var statusText: String {
        if sending { return "sending…" }
        switch conn.status {
        case .connected:
            if store.currentTurns.last?.taken == true, store.currentTurns.last?.agentText == nil { return "agent reading…" }
            let listening = conn.agents.filter(\.waiting)
            switch listening.count {
            case 0: return conn.agentListening ? "agent listening" : "nobody listening"
            case 1: return "\(listening[0].name) listening"
            default: return "\(listening.count) agents listening"
            }
        case .connecting: return "connecting…"
        case .disconnected: return "offline"
        }
    }

    func chromeButton(_ symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: { canvasController.isDrawing = false; action() }) { Image(systemName: symbol).font(.body.weight(.medium)).frame(width: 44, height: 44).background(.thinMaterial, in: Circle()) }
            .buttonStyle(.plain).foregroundStyle(.primary)
    }

    var rail: some View {
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

    func railButton(_ symbol: String, on: Bool = false, badge: Int = 0, action: @escaping () -> Void) -> some View {
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

    func toggleDrawer(_ t: DrawerTab) {
        canvasController.isDrawing = false
        if showDrawer && tab == t { showDrawer = false } else { tab = t; showDrawer = true }
        if t == .turns { unread = 0 }
    }

    var sendButton: some View {
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
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(sending || (drawing.strokes.isEmpty && store.current.layers.isEmpty))
                // The floating PencilKit picker spans most of a narrow (portrait) width; keep Send above it there.
                .padding(.trailing, rightInset + 24).padding(.bottom, geo.size.width - rightInset < 1000 ? 130 : 28)
            }
        }
        }
    }

    func toast(_ s: String) -> some View {
        VStack { Spacer()
            Text(s).font(.callout.weight(.medium)).padding(.horizontal, 14).padding(.vertical, 9).background(.thinMaterial, in: Capsule())
                .padding(.bottom, 110)
        }.frame(maxWidth: .infinity).padding(.trailing, rightInset).transition(.opacity)
    }

    // MARK: board & strokes

    func loadCurrentBoard() {
        guard loadedBoardID != store.currentID else { return }
        loadedBoardID = store.currentID
        drawing = store.current.drawing
    }

    func strokesChanged() {
        var b = store.current
        b.drawing = drawing
        b.sentStrokeCount = min(b.sentStrokeCount, drawing.strokes.count)
        store.current = b
    }

    func layerImage(_ l: Layer) -> UIImage? { store.image(named: l.file, in: store.layersDir) }

    func renderCurrent(highlight: Bool) -> TurnRenderer.Output? {
        TurnRenderer.render(drawing, layers: store.current.layers, layerImage: layerImage, sentStrokeCount: store.current.sentStrokeCount, highlightNew: highlight)
    }

    func send() async { await sendTurn() }

    var drawerActions: DrawerActions {
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
