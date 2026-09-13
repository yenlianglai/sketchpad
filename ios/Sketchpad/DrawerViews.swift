import SwiftUI
import PencilKit

enum DrawerTab: String, CaseIterable { case turns = "Turns", media = "Media", pages = "Pages" }

/// Actions the drawer can ask the main view to perform.
struct DrawerActions {
    var placeSketch: (Turn, AgentItem) -> Void
    var placeLayer: (Turn, AgentItem) -> Void
    var branch: (Turn) -> Void
    var preview: (Turn) -> Void
    var removeAgentStrokes: (Turn) -> Void
    var openBoard: (UUID) -> Void
    var newBoard: () -> Void
    var flash: (String) -> Void
}

// MARK: - Drawer shell

struct Drawer: View {
    @Binding var tab: DrawerTab
    let actions: DrawerActions
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 22) {
                ForEach(DrawerTab.allCases, id: \.self) { t in
                    Button { withAnimation(.easeInOut(duration: 0.15)) { tab = t } } label: {
                        Text(t.rawValue).font(.subheadline.weight(.semibold))
                            .foregroundStyle(tab == t ? Color.primary : Color.secondary)
                            .padding(.bottom, 12)
                            .overlay(alignment: .bottom) { if tab == t { Rectangle().fill(Color.primary).frame(height: 2) } }
                    }.buttonStyle(.plain)
                }
                Spacer()
            }
            .padding(.horizontal, 20).padding(.top, 18)
            .overlay(alignment: .bottom) { Divider() }
            switch tab {
            case .turns: TurnsTab(actions: actions)
            case .media: MediaTab(actions: actions)
            case .pages: PagesTab(actions: actions)
            }
        }
        .background(.regularMaterial)
        .overlay(alignment: .leading) { Divider() }
    }
}

// MARK: - Turns

struct TurnsTab: View {
    @EnvironmentObject var store: BoardStore
    let actions: DrawerActions
    var body: some View {
        let turns = store.currentTurns
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if turns.isEmpty {
                        Text("Draw something and press Send. Each turn and the agent's reply show up here.")
                            .font(.callout).foregroundStyle(.secondary).padding(.top, 24).padding(.horizontal, 8)
                    }
                    ForEach(Array(turns.enumerated()), id: \.element.id) { i, t in
                        TurnCard(turn: t, index: i + 1, actions: actions).id(t.id)
                    }
                }
                .padding(14)
            }
            .onChange(of: turns.count) { _, _ in if let last = turns.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } } }
            .onChange(of: turns.last?.agentItems.count) { _, _ in if let last = turns.last { withAnimation { proxy.scrollTo(last.id, anchor: .bottom) } } }
        }
    }
}

struct TurnCard: View {
    @EnvironmentObject var store: BoardStore
    let turn: Turn
    let index: Int
    let actions: DrawerActions
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(turn.agentInitiated ? "Turn \(index) · agent" : "Turn \(index) · you" + (turn.newStrokes > 0 ? " · +\(turn.newStrokes) strokes" : ""))
                    .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer()
                Text(turn.time.formatted(date: .omitted, time: .shortened)).font(.caption).foregroundStyle(.secondary)
            }
            if let img = store.turnImage(turn) {
                Image(uiImage: img).resizable().scaledToFit().frame(maxHeight: 150).frame(maxWidth: .infinity)
                    .background(.white).clipShape(RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
            }
            if !turn.note.isEmpty { Text(turn.note).font(.subheadline) }
            if let a = turn.agentText, !a.isEmpty {
                HStack(alignment: .top, spacing: 8) {
                    Circle().fill(Color(uiColor: Settings.agentColor)).frame(width: 6, height: 6).padding(.top, 6)
                    Text(a).font(.subheadline).textSelection(.enabled)
                }
            } else if turn.taken {
                Text("Agent is looking…").font(.caption).foregroundStyle(.secondary)
            }
            if !turn.agentItems.isEmpty {
                FlowChips(items: turn.agentItems) { item in
                    Button {
                        if item.kind == "sketch" { actions.placeSketch(turn, item) } else { actions.placeLayer(turn, item) }
                    } label: {
                        Label(item.kind == "sketch" ? "sketch · draw again" : (item.placedAsLayer ? "\(item.kind) · placed" : "\(item.kind) · place as layer"),
                              systemImage: item.kind == "sketch" ? "pencil.and.outline" : "square.on.square")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.bordered).controlSize(.small).tint(Color(uiColor: Settings.agentColor))
                    .disabled(item.kind != "sketch" && item.file == nil)
                }
            }
        }
        .padding(12)
        .background(Color.white.opacity(0.9), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.black.opacity(0.05)))
        .contextMenu { menu }
        .onTapGesture { actions.preview(turn) }
    }

    @ViewBuilder private var menu: some View {
        Button { actions.branch(turn) } label: { Label("Branch into a new page", systemImage: "arrow.triangle.branch") }
        Button { actions.preview(turn) } label: { Label("Show this turn", systemImage: "eye") }
        if let f = turn.pngFile { ShareLink(item: store.turnsDir.appendingPathComponent(f)) { Label("Export this image", systemImage: "square.and.arrow.up") } }
        if store.current.agentStrokes[turn.id]?.isEmpty == false {
            Button(role: .destructive) { actions.removeAgentStrokes(turn) } label: { Label("Remove agent strokes from this turn", systemImage: "eraser") }
        }
    }
}

/// Wrapping row of chips.
struct FlowChips<Content: View>: View {
    let items: [AgentItem]
    let content: (AgentItem) -> Content
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 6) {
            ForEach(items) { content($0) }
        }
    }
}

// MARK: - Media

struct MediaTab: View {
    @EnvironmentObject var store: BoardStore
    let actions: DrawerActions
    struct Item: Identifiable { let id: String; let image: UIImage?; let label: String; let isAgent: Bool; let turn: Turn; let agentItem: AgentItem?; let fileURL: URL? }

    private var items: [Item] {
        var out: [Item] = []
        for (i, t) in store.currentTurns.enumerated() {
            out.append(Item(id: t.id, image: store.turnImage(t), label: "you · turn \(i + 1)", isAgent: false, turn: t, agentItem: nil, fileURL: t.pngFile.map { store.turnsDir.appendingPathComponent($0) }))
            for a in t.agentItems where a.kind != "sketch" {
                let img = a.file.flatMap { store.image(named: $0, in: store.agentDir) }
                out.append(Item(id: a.id.uuidString, image: img, label: "agent · \(a.kind)", isAgent: true, turn: t, agentItem: a, fileURL: a.file.map { store.agentFileURL($0) }))
            }
        }
        return out.reversed()
    }

    var body: some View {
        let list = items
        ScrollView {
            HStack { Text("This page · \(list.count) items").font(.caption).foregroundStyle(.secondary); Spacer() }.padding(.horizontal, 16).padding(.top, 14)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
                ForEach(list) { it in
                    Menu {
                        if let a = it.agentItem, a.file != nil { Button { actions.placeLayer(it.turn, a) } label: { Label("Place as layer", systemImage: "square.on.square") } }
                        if let u = it.fileURL { ShareLink(item: u) { Label("Share", systemImage: "square.and.arrow.up") } }
                        Button { actions.preview(it.turn) } label: { Label("Show turn", systemImage: "eye") }
                    } label: {
                        ZStack(alignment: .topLeading) {
                            Group {
                                if let img = it.image { Image(uiImage: img).resizable().scaledToFill() } else { ProgressView() }
                            }
                            .frame(height: 118).frame(maxWidth: .infinity).background(.white).clipped()
                            Text(it.label).font(.caption2.weight(.semibold))
                                .padding(.horizontal, 7).padding(.vertical, 3)
                                .background(it.isAgent ? Color(red: 0.98, green: 0.91, blue: 0.88) : Color(white: 0.92), in: Capsule())
                                .foregroundStyle(it.isAgent ? Color(uiColor: Settings.agentColor) : .primary)
                                .padding(8)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(.black.opacity(0.06)))
                    }
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 16)
        }
    }
}

// MARK: - Pages

struct PagesTab: View {
    @EnvironmentObject var store: BoardStore
    let actions: DrawerActions
    @State private var renaming: Board?
    @State private var newTitle = ""
    @StateObject private var thumbs = ThumbCache()

    var body: some View {
        ScrollView {
            HStack {
                Text("\(store.boards.count) pages · recent first").font(.caption).foregroundStyle(.secondary)
                Spacer()
                Button { actions.newBoard() } label: { Label("New page", systemImage: "plus") }.buttonStyle(.borderedProminent).controlSize(.small).tint(.black)
            }
            .padding(.horizontal, 16).padding(.top, 14)
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 12), GridItem(.flexible(), spacing: 12)], spacing: 16) {
                ForEach(store.boardsByRecency) { b in
                    Button { actions.openBoard(b.id) } label: {
                        VStack(alignment: .leading, spacing: 6) {
                            ZStack(alignment: .topLeading) {
                                Group {
                                    if let img = thumbs.image(for: b, store: store) { Image(uiImage: img).resizable().scaledToFit() }
                                    else { Color.white }
                                }
                                .frame(height: 110).frame(maxWidth: .infinity).background(.white)
                                if b.branchedFrom != nil {
                                    Label("branch", systemImage: "arrow.triangle.branch").font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 6).padding(.vertical, 3).background(.white.opacity(0.9), in: Capsule()).padding(6)
                                }
                            }
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(b.id == store.currentID ? Color.primary : Color.black.opacity(0.06), lineWidth: b.id == store.currentID ? 2 : 1))
                            Text(b.title).font(.subheadline.weight(.semibold)).lineLimit(1).foregroundStyle(.primary)
                            Text("\(store.turnsFor(b.id).count) turns · \(b.updatedAt.formatted(.relative(presentation: .named)))").font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button { renaming = b; newTitle = b.title } label: { Label("Rename", systemImage: "pencil") }
                        Button { store.duplicate(b.id) } label: { Label("Duplicate", systemImage: "plus.square.on.square") }
                        Button(role: .destructive) { store.delete(b.id) } label: { Label("Delete", systemImage: "trash") }
                    }
                }
            }
            .padding(16)
        }
        .alert("Rename page", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Title", text: $newTitle)
            Button("Save") { if let b = renaming { store.rename(b.id, to: newTitle); var bb = store.board(b.id)!; bb.titleLocked = true; store.current = bb }; renaming = nil }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }
}

/// Page thumbnails, regenerated only when a board changes.
@MainActor
final class ThumbCache: ObservableObject {
    private var cache: [UUID: (Date, UIImage?)] = [:]
    func image(for b: Board, store: BoardStore) -> UIImage? {
        if let c = cache[b.id], c.0 == b.updatedAt { return c.1 }
        let img = TurnRenderer.thumbnail(b.drawing, layers: b.layers) { store.image(named: $0.file, in: store.layersDir) }
        cache[b.id] = (b.updatedAt, img)
        return img
    }
}

// MARK: - Turn preview sheet

struct TurnPreview: View {
    @EnvironmentObject var store: BoardStore
    let turn: Turn
    let onBranch: () -> Void
    @Environment(\.dismiss) var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let img = store.turnImage(turn) { Image(uiImage: img).resizable().scaledToFit().background(.white).clipShape(RoundedRectangle(cornerRadius: 12)).overlay(RoundedRectangle(cornerRadius: 12).stroke(.quaternary)) }
                    if !turn.note.isEmpty { Text(turn.note) }
                    if let a = turn.agentText { HStack(alignment: .top, spacing: 8) { Circle().fill(Color(uiColor: Settings.agentColor)).frame(width: 8, height: 8).padding(.top, 6); Text(a) } }
                }.padding(20)
            }
            .navigationTitle("Turn · \(turn.time.formatted(date: .omitted, time: .shortened))")
            .toolbar {
                ToolbarItem(placement: .primaryAction) { Button { onBranch(); dismiss() } label: { Label("Branch", systemImage: "arrow.triangle.branch") } }
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
            }
        }
    }
}

// MARK: - Settings

struct SettingsView: View {
    @EnvironmentObject var settings: Settings
    @EnvironmentObject var conn: ServerConnection
    @Environment(\.dismiss) var dismiss
    @State private var showManual = false

    private var statusLine: String {
        switch conn.status {
        case .connected: return conn.agentListening ? "Connected · an agent is listening" : "Connected · no agent listening yet"
        case .connecting: return "Connecting…"
        case .disconnected: return "Not connected"
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("Mac") { Text(settings.host.isEmpty ? "not set" : settings.host).foregroundStyle(.secondary) }
                    HStack(spacing: 8) {
                        Circle().fill(conn.status == .connected ? (conn.agentListening ? Color.green : Color.orange) : Color.red).frame(width: 8, height: 8)
                        Text(statusLine).font(.subheadline).foregroundStyle(.secondary)
                    }
                    ForEach(conn.discovered.filter { $0 != settings.host }, id: \.self) { h in
                        Button { settings.host = h } label: { Label("Switch to \(h)", systemImage: "bonjour") }
                    }
                    if let e = conn.lastError, conn.status != .connected { Text(e).font(.footnote).foregroundStyle(.red) }
                } header: { Text("Connection") } footer: {
                    Text("Sketchpad finds your Mac on the network by itself. Start it there with `npm run web-only`.")
                }

                Section("Canvas") {
                    Picker("Paper", selection: $settings.paper) { Text("Plain").tag(Paper.plain); Text("Dots").tag(Paper.dots); Text("Grid").tag(Paper.grid) }.pickerStyle(.segmented)
                    Toggle("Pencil only", isOn: $settings.pencilOnly)
                    Text("Fingers pan and zoom; only the Pencil draws. Turn off to draw with a finger.")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section {
                    DisclosureGroup("Advanced", isExpanded: $showManual) {
                        TextField("Address (e.g. 192.168.0.128:8791)", text: $settings.host).textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
                        TextField("Token", text: $settings.token).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// Shown over the canvas until an iPad has a Mac to talk to.
struct ConnectionCard: View {
    let discovered: [String]
    var onPick: (String) -> Void
    var onManual: () -> Void
    var body: some View {
        VStack(spacing: 14) {
            if discovered.isEmpty {
                ProgressView().controlSize(.large)
                Text("Looking for your Mac").font(.headline)
                Text("Start Sketchpad on the Mac with `npm run web-only`, and keep both on the same network.")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            } else {
                Text("Found your Mac").font(.headline)
                ForEach(discovered, id: \.self) { h in
                    Button { onPick(h) } label: { Label(h, systemImage: "laptopcomputer").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent).tint(.black).controlSize(.large)
                }
            }
            Button("Enter an address instead", action: onManual).font(.subheadline)
        }
        .padding(28).frame(maxWidth: 420)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .shadow(color: .black.opacity(0.14), radius: 20, y: 8)
    }
}
