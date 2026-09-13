import SwiftUI
import PencilKit

/// What happens when the agent answers: queueing the reply, and putting it on the canvas when you
/// say so.
extension ContentView {

    func wireEvents() {
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

    func handleReply(_ r: Reply) {
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
    func place(_ reply: PendingReply, at point: CGPoint?) {
        guard let turn = store.turn(reply.turnId), let item = turn.agentItems.first(where: { $0.id == reply.itemId }) else { return }
        guard turn.boardID == store.currentID else { showFlash("That reply belongs to another page"); return }
        if reply.kind == "sketch" { placeSketch(turn: turn, item: item, at: point, announce: true) }
        else { placeLayer(turn: turn, item: item, at: point) }
        withAnimation { replyQueue.removeAll { $0.id == reply.id } }
    }

    // MARK: placing agent output

    /// Convert the agent's SVG into pen strokes aligned with the turn's image, appended one by one.
    func placeSketch(turn: Turn, item: AgentItem, at point: CGPoint? = nil, announce: Bool) {
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
        // Scroll to where it is about to draw, so you never miss it happening off-screen.
        canvasController.reveal(PKDrawing(strokes: strokes).bounds)
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
    func placeLayer(turn: Turn, item: AgentItem, at point: CGPoint? = nil) {
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

    func branch(_ t: Turn) {
        let b = store.branch(from: t)
        showFlash("Branched into “\(b.title)”")
    }
}
