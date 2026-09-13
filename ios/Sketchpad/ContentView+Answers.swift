import SwiftUI
import UIKit

/// Answering the Mac's questions.
///
/// The server keeps nothing of what you draw — it holds a page only long enough to hand it to an
/// agent. So when the agent looks back through the history, the question comes here, and the answer
/// is read out of this device's own store.
extension ContentView {

    func answer(id: String, kind: String, params: [String: Any]) {
        switch kind {
        case "canvas":
            conn.postAnswer(id: id, png(renderCurrent(highlight: false)?.png))

        case "list_turns":
            let limit = (params["limit"] as? Int) ?? 20
            var turns = store.turns
            if (params["boardId"] as? String) != "all" {
                let board = (params["boardId"] as? String).flatMap(UUID.init(uuidString:)) ?? store.currentID
                turns = turns.filter { $0.boardID == board }
            }
            let rows = turns.sorted { $0.time > $1.time }.prefix(limit).map(summary)
            conn.postAnswer(id: id, ["turns": rows])

        case "get_turn":
            guard let turnId = params["turnId"] as? String, let turn = store.turn(turnId) else {
                conn.postAnswer(id: id, [:])   // an id this device has never heard of
                return
            }
            var row = summary(turn)
            if (params["includeImage"] as? Bool) != false,
               let data = store.turnImage(turn)?.pngData() {
                row["png"] = data.base64EncodedString()
            }
            conn.postAnswer(id: id, ["turn": row])

        default:
            conn.postAnswer(id: id, [:])   // a newer server asking for something this app does not know
        }
    }

    private func png(_ data: Data?) -> [String: Any] {
        guard let data else { return [:] }
        return ["png": "data:image/png;base64," + data.base64EncodedString()]
    }

    /// One turn as the agent sees it. Replies are summarised by what they added, not their contents —
    /// the agent wrote them, so it does not need them read back.
    private func summary(_ t: Turn) -> [String: Any] {
        [
            "turnId": t.id,
            "ts": t.time.timeIntervalSince1970 * 1000,
            "boardTitle": store.board(t.boardID)?.title ?? "",
            "strokes": t.newStrokes,
            "text": t.note,
            "replies": t.agentItems.map { ["kind": $0.kind] } + (t.agentText?.isEmpty == false && t.agentItems.isEmpty ? [["kind": "text"]] : [])
        ]
    }
}
