import SwiftUI
import PencilKit

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
