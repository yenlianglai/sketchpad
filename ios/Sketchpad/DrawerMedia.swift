import SwiftUI
import PencilKit

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
                        MediaTile(item: it)
                    }
                }
            }
            .padding(.horizontal, 16).padding(.bottom, 16)
        }
    }
}

/// One image in the Media grid. Pages are cropped to their content, so they come in at every
/// aspect ratio going: fit the whole thing rather than filling and cropping the middle out of it.
struct MediaTile: View {
    let item: MediaTab.Item
    /// An agent image has no local file until the download finishes.
    private var isLoading: Bool { item.agentItem != nil && item.fileURL == nil }

    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.white
            if let img = item.image {
                Image(uiImage: img).resizable().scaledToFit().padding(6)
            } else if isLoading {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "photo").font(.title3).foregroundStyle(.tertiary)
            }
            Text(item.label).font(.caption2.weight(.semibold))
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background(item.isAgent ? Color(red: 0.98, green: 0.91, blue: 0.88) : Color(white: 0.92), in: Capsule())
                .foregroundStyle(item.isAgent ? Color(uiColor: Settings.agentColor) : .primary)
                .padding(8)
        }
        .frame(height: 118).frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.black.opacity(0.06)))
    }
}
