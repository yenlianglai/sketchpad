import SwiftUI
import PencilKit

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
