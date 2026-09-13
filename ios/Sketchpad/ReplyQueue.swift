import SwiftUI
import UIKit

/// One agent reply waiting for you to decide what to do with it. Nothing the agent sends lands on
/// the canvas on its own: it queues here until you place it or dismiss it.
struct PendingReply: Identifiable, Equatable {
    let id = UUID()
    var turnId: String
    var itemId: UUID
    var kind: String            // sketch | mermaid | drawio | image | other | text
    var text: String
    var preview: UIImage?
    var downloading = false
    var failed = false
    var suggested = false       // the agent asked for it to go straight onto the canvas

    var isText: Bool { kind == "text" }
    var canPlace: Bool { !isText && !downloading && !failed }
    static func == (a: PendingReply, b: PendingReply) -> Bool {
        a.id == b.id && a.downloading == b.downloading && a.failed == b.failed && a.text == b.text && (a.preview === b.preview)
    }
}

/// Stack of reply cards over the bottom-left of the canvas. Newest sits at the bottom, nearest the hand.
struct ReplyQueueView: View {
    let replies: [PendingReply]
    var onPlace: (PendingReply) -> Void
    var onDismiss: (PendingReply) -> Void
    var onOpen: (PendingReply) -> Void
    var onDragChanged: (PendingReply, CGPoint) -> Void
    var onDragEnded: (PendingReply, CGPoint) -> Void

    private let maxVisible = 2

    var body: some View {
        let shown = Array(replies.suffix(maxVisible))
        let hidden = replies.count - shown.count
        VStack(alignment: .leading, spacing: 8) {
            if hidden > 0 {
                Text("\(hidden) more in Turns").font(.caption).foregroundStyle(.secondary)
                    .padding(.horizontal, 10).padding(.vertical, 5).background(.regularMaterial, in: Capsule())
            }
            ForEach(shown) { r in
                ReplyCard(reply: r, onPlace: { onPlace(r) }, onDismiss: { onDismiss(r) }, onOpen: { onOpen(r) },
                          onDragChanged: { onDragChanged(r, $0) }, onDragEnded: { onDragEnded(r, $0) })
                    .transition(.asymmetric(insertion: .move(edge: .leading).combined(with: .opacity), removal: .opacity))
            }
        }
    }
}

struct ReplyCard: View {
    let reply: PendingReply
    var onPlace: () -> Void
    var onDismiss: () -> Void
    var onOpen: () -> Void
    var onDragChanged: (CGPoint) -> Void
    var onDragEnded: (CGPoint) -> Void

    @State private var dragging = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Circle().fill(Color(uiColor: Settings.agentColor)).frame(width: 6, height: 6)
                Text(reply.isText ? "agent" : "agent · \(reply.kind)").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer(minLength: 8)
                Button(action: onDismiss) { Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(.secondary).frame(width: 28, height: 28).contentShape(Rectangle()) }
                    .buttonStyle(.plain)
            }
            if !reply.text.isEmpty {
                Text(reply.text).font(.subheadline).lineLimit(4).fixedSize(horizontal: false, vertical: true)
                    .onTapGesture(perform: onOpen)
            }
            if reply.downloading {
                HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Fetching…").font(.caption).foregroundStyle(.secondary) }
            } else if reply.failed {
                Text("Could not fetch that image").font(.caption).foregroundStyle(.red)
            } else if let img = reply.preview {
                Image(uiImage: img).resizable().scaledToFit().frame(maxWidth: 276, maxHeight: 120)
                    .background(.white).clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(.black.opacity(0.08)))
                    .opacity(dragging ? 0.25 : 1)
                    .gesture(DragGesture(coordinateSpace: .global)
                        .onChanged { v in dragging = true; onDragChanged(v.location) }
                        .onEnded { v in dragging = false; onDragEnded(v.location) })
            }
            if reply.canPlace {
                HStack(spacing: 8) {
                    Button(action: onPlace) {
                        Label(reply.kind == "sketch" ? "Add to drawing" : "Place", systemImage: reply.kind == "sketch" ? "pencil.and.outline" : "square.on.square")
                            .font(.caption.weight(.semibold))
                    }
                    .buttonStyle(.borderedProminent).controlSize(.small).tint(Color(uiColor: Settings.agentColor))
                    Text("or drag it").font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .padding(12)
        .frame(width: 300, alignment: .leading)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(reply.suggested ? Color(uiColor: Settings.agentColor).opacity(0.5) : .black.opacity(0.06)))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 6)
    }
}

/// The image following your finger while you drag a reply onto the canvas.
struct DragGhost: View {
    let image: UIImage
    let point: CGPoint
    let size: CGSize
    var body: some View {
        Image(uiImage: image).resizable().scaledToFit()
            .frame(width: size.width, height: size.height)
            .opacity(0.75)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(uiColor: Settings.agentColor), style: StrokeStyle(lineWidth: 2, dash: [6, 4])))
            .position(point)
            .allowsHitTesting(false)
    }
}
