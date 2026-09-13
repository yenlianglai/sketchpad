import SwiftUI
import PencilKit

/// Sending a page, and keeping the board in step with the canvas.
extension ContentView {

    @MainActor
    func sendTurn() async {
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

    func showFlash(_ s: String) {
        flash = s
        Task { try? await Task.sleep(nanoseconds: 1_800_000_000); if flash == s { flash = nil } }
    }
}
